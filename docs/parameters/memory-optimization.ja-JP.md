<a name="guide-title"></a>
# VRAM 最適化と速度の実測

<a name="quick-guide"></a>
## GPU の VRAM 容量別の設定目安

省メモリ設定は「劣化のないキャッシュ → 量子化と compile → 不足分をブロックスワップで補う」の順で有効化してください（以下の全構成で**勾配チェックポイント**・**latent をディスクに保存**・**テキストエンコーダの出力をキャッシュ**・**`AdamW8bit`** などの 8-bit オプティマイザを有効にし、`batch_size = 1` と勾配累積を前提とします）：

| GPU の VRAM 容量 | Anima（約 2B〜2.9B） | MOSS-Image / Krea 2（大型 DiT） | トレードオフの要点 |
| --- | --- | --- | --- |
| **16–24 GB+** | `bf16`・`DiT のブロックスワップ数 = 0` のまま、空き VRAM に応じて[勾配チェックポイントを省く末尾ブロック数](#anima-partial-checkpointing)（`14–28`）を増やす | **ConvRot INT8**（または Krea 2 の **DiT の FP8 動的量子化**）+ `torch.compile` を有効化。24 GB の GPU で **MOSS-Image** を学習する場合は、末尾 `7–14` ブロックの勾配チェックポイントを省略できます。 | 余剰 VRAM を活かしてステップ速度を **15%〜45%** 短縮 |
| **10–12 GB** | `bf16` + 勾配チェックポイント全有効でそのまま動作（1024px でピーク約 **`6.7 GB`**） | **ConvRot INT8**（または Krea 2 の **DiT の FP8 動的量子化**）+ `compile` を有効化（MOSS 1024px の学習中ピーク約 **`9.1–10.0 GB`**）。MOSS 初回のテキストキャッシュ作成時は、テキストエンコーダの `ConvRot INT8` または[テキストエンコーダのブロックスワップ数](#moss-text-encoder-swap) `28–32` を設定 | 起動時のキャッシュ作成ピークを抑えつつ高速に学習 |
| **6–8 GB** | 1024px で逼迫する場合は [DiT のブロックスワップ](#block-swap)（`8–16`）+ `H2D-only` を追加 | **ConvRot INT8**（または Krea 2 の **DiT の FP8 動的量子化**）に加え、**MOSS-Image** は [DiT のブロックスワップ数](#block-swap)を `20–36`（`36` ブロック時で学習中実測 `5.2 GB`）、**Krea 2** は `16–26`（上限 `26`、**Turbo DiT** プレビュー高速化をオフ）に設定。いずれも勾配チェックポイント有効時に `H2D-only` + ピン留めメモリを併用可（**16–32 GB+** のシステム RAM を推奨） | PCIe 転送時間とシステム RAM を引き換えに 6–8 GB 環境で動作させる |

<a name="block-swap"></a>
## DiT のブロックスワップと排他制約

**DiT のブロックスワップ数**（`blocks_to_swap`）は、指定した個数の DiT Transformer ブロックをシステムメモリ（CPU RAM）に置き、順伝播・逆伝播で順番が回ってきたブロックだけを GPU VRAM へ転送します。数値精度は変わりませんが、システム RAM 使用量（**16–32 GB+** 推奨）とステップごとの PCIe 転送待ち時間が増えます。

- **モデル種別ごとのスワップ上限**：
  - **Anima**：最大 `総ブロック数 - 2`（28 ブロックの Anima-Preview は **`26`**、40 ブロックの Anima-2.9B は **`38`** まで）。
  - **Krea 2**：最大 **`26`** ブロック。スワップ数が `0` より大きく勾配チェックポイントが有効な場合は、`H2D-only` とピン留めメモリを有効にできます。ブロックスワップ使用時は **Turbo DiT** プレビュー高速化をオフにしてください。
  - **MOSS-Image**：最大 **`40`** ブロック。実測の VRAM・CPU RAM 使用量は下の [MOSS-Image DiT のブロックスワップ数](#moss-block-swap)を参照してください。
- **H2D-only とピン留めメモリ**：`H2D-only` を有効にすると、逆伝播が終わったブロックを CPU へ書き戻さず（D2H 省略）GPU 側でそのまま解放します。ピン留めメモリ（Pinned Memory）と組み合わせることで、PCIe 帯域が狭い環境でもスワップ時間を約 2 割短縮できます。
- **他の項目との排他制約**：
  - **勾配チェックポイントの CPU オフロード / Unsloth 非同期活性値オフロード**とは併用できません。
  - **`H2D-only`** と**勾配チェックポイントを省く末尾ブロック数**を同時に使う場合、スワップ数と省略数の少なくとも一方を `block_swap_ring_size`（既定 `2`）以下にする必要があります。多めのブロックをスワップする際は、末尾ブロックのチェックポイント省略数を `0` に保ってください。
  - ブロック単位の `torch.compile` と併用する場合は、`compile_fullgraph` をオフ（`false`）にする必要があります。

<a name="anima"></a>
## Anima

<a name="anima-partial-checkpointing"></a>
### 勾配チェックポイントを省く末尾ブロック数

VRAM に余裕があり多数のブロックスワップを行わない場合、バックボーン末尾の指定ブロック数だけ順伝播の活性化を保持し、逆伝播時の再計算を省いて高速化できます（上限は Anima-Preview が `28`、Anima-2.9B が `40`）。

測定条件：約 1 MP（`1024×1024`）、`batch_size = 1`、LoRA Rank `16`、`bf16`、Flash Attention。勾配チェックポイント・Latent キャッシュ・テキストキャッシュ有効。VRAM は学習中の `nvidia-smi` ピークです。

| 省略ブロック数 | PRO 6000 Blackwell VRAM | 秒/step | RTX 4090 VRAM | 秒/step |
| --- | --- | --- | --- | --- |
| `0` | `6.5 GB` | `0.85` | `6.7 GB` | `0.73` |
| `7` | `9.4 GB` | `0.75` | `9.6 GB` | `0.68` |
| `14` | `12.9 GB` | `0.73` | `13.0 GB` | `0.63` |
| `21` | `16.4 GB` | `0.59` | `16.5 GB` | `0.56` |
| `28` | `19.9 GB` | `0.53` | `20.0 GB` | `0.52` |

出典：[sd-scripts `anima_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)

<a name="moss"></a>
## MOSS-Image

<a name="moss-partial-checkpointing"></a>
### 勾配チェックポイントを省く末尾ブロック数

測定条件：約 1 MP、`batch_size = 1`、LoRA Rank `16`、Flash Attention。勾配チェックポイント・Latent キャッシュ・テキストキャッシュ有効（`ConvRot INT8 + compile` の時間はウォームアップ後、VRAM は CUDA コンテキストを含む学習中の `nvidia-smi` ピーク）。

<a name="moss-skip-pro6000"></a>
#### RTX PRO 6000 Blackwell

（`bf16` テキストエンコーダでキャッシュを作成する際の起動時ピークは約 `15.6 GB` です。）

| 省略ブロック数 | `bf16` VRAM | 秒/step | `ConvRot INT8 + compile` VRAM | 秒/step |
| --- | --- | --- | --- | --- |
| `0` | `13.5 GB` | `1.29` | `10.0 GB` | `0.84` |
| `11` | `23.4 GB` | `1.21` | `15.4 GB` | `0.79` |
| `21` | `33.6 GB` | `1.13` | `21.9 GB` | `0.74` |
| `32` | `44.9 GB` | `1.02` | `29.1 GB` | `0.70` |
| `42` | `55.0 GB` | `0.93` | `35.5 GB` | `0.64` |

<a name="moss-skip-4090"></a>
#### RTX 4090（テキストエンコーダは ConvRot INT8）

| DiT 構成 | 省略ブロック数 | ピーク VRAM | 秒/step |
| --- | --- | --- | --- |
| `bf16` | `0` | `14.3 GB` | `1.88` |
| `bf16` | `5` | `17.6 GB` | `1.83` |
| `bf16` | `10` | `22.5 GB` | `1.77` |
| `ConvRot INT8 + compile` | `0` | `10.0 GB` | `1.00` |
| `ConvRot INT8 + compile` | `7` | `13.0 GB` | `0.98` |
| `ConvRot INT8 + compile` | `14` | `17.5 GB` | `0.94` |
| `ConvRot INT8 + compile` | `21` | `22.0 GB` | `0.90` |

補足：`compile` なしで `ConvRot INT8` のみを有効にした場合、ステップ時間は `bf16` とほぼ同等で主に VRAM 削減に効きます（PRO 6000 で `1.41 秒/step` 対 `1.45 秒/step`）。高速化も得るには `torch.compile` を併用してください。出典：[sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

<a name="moss-block-swap"></a>
### DiT のブロックスワップ数

測定条件：RTX PRO 6000 Blackwell、Windows、`1024×1024`、`batch_size = 1`、LoRA Rank `16`、AdamW。勾配チェックポイント・Latent ディスクキャッシュ・テキストキャッシュ有効（従来スワップ方式。VRAM は CUDA コンテキストを含む `nvidia-smi` ピーク、起動 VRAM は初回のテキストキャッシュ作成を含み、CPU RAM はプロセスのワーキングセットピーク。排他制約は上の [DiT のブロックスワップと排他制約](#block-swap)を参照）：

| DiT / テキストエンコーダ精度 | 省メモリ構成 | 起動 VRAM | 学習 VRAM | CPU RAM |
| --- | --- | --- | --- | --- |
| `bf16` / `bf16` | スワップなし | `15.3 GB` | `13.2 GB` | `17.2 GB` |
| `ConvRot INT8` / `ConvRot INT8` | スワップなし | `9.1 GB` | `9.1 GB` | `9.9 GB` |
| `ConvRot INT8` / `ConvRot INT8` | Unsloth 非同期オフロード | `8.2 GB` | `8.2 GB` | `11.2 GB` |
| `bf16` / `ConvRot INT8` | `20` ブロックスワップ | `9.0 GB` | `9.0 GB` | `18.5 GB` |
| `ConvRot INT8` / `ConvRot INT8` | `20` ブロックスワップ | `7.9 GB` | `6.9 GB` | `14.0 GB` |
| `ConvRot INT8` / `ConvRot INT8` | `36` ブロックスワップ | `7.9 GB` | `5.2 GB` | `15.6 GB` |

<a name="moss-swap-h2d"></a>
#### 36 ブロックスワップ：従来方式と H2D-only の速度比較

測定条件：RTX 3090、PCIe Gen3 x4、`bf16`、`1024×1024`、`batch_size = 1`（`—` は上流文書で未記載）：

| スワップ方式 | VRAM | 秒/step |
| --- | --- | --- |
| 従来方式 | — | `≈ 11.7` |
| `H2D-only` + ピン留めメモリ | `≈ 7 GB` | `≈ 9.4` |

出典：[sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md) · [`block_swap.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)

<a name="moss-text-encoder-swap"></a>
### テキストエンコーダのブロックスワップ数

MOSS-Image の学習開始時にデータセットのテキストキャッシュを作成する際、テキストエンコーダのスワップが `0` だと Qwen テキストエンコーダ全体が VRAM に載り、`nvidia-smi` ピーク（CUDA コンテキスト込み）は `bf16` で **`15.5 GB`**、`ConvRot INT8` で **`8.3 GB`** に達します。8–12 GB クラスの GPU では、DiT の学習自体は収まる設定でもこの初回キャッシュ作成で VRAM 不足になることがあります。

**テキストエンコーダのブロックスワップ数**を増やすと、初回のテキストキャッシュ作成中だけ Qwen の各層を順番に転送して処理し、キャッシュ書き出し完了後は DiT 学習が始まる前にアンロードされます（スワップありの行は約 2000 token の説明文 1 件に対する PyTorch の GPU テンソル割り当てピーク）：

| テキストエンコーダ精度 | スワップ層数 | 測定基準 | ピーク VRAM |
| --- | --- | --- | --- |
| `bf16` | `0`（スワップなし） | `nvidia-smi` 全体ピーク | `15.5 GB` |
| `ConvRot INT8` | `0`（スワップなし） | `nvidia-smi` 全体ピーク | `8.3 GB` |
| `bf16` | `28` | PyTorch GPU 割り当てピーク | `5.1 GB` |
| `bf16` | `32` | PyTorch GPU 割り当てピーク | `3.5 GB` |
| `ConvRot INT8` | `32` | PyTorch GPU 割り当てピーク | `2.2 GB` |

層転送のオーバーヘッドが発生するのは初回キャッシュ作成時のみです（RTX PRO 6000・PCIe 5.0・`bf16` で、`0` 層の `0.1–0.3 秒/件` に対し `28` 層で `≈ 0.7 秒/件`）。一度ディスクへキャッシュされた後の学習ステップ速度には影響しません。出典：[sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)
