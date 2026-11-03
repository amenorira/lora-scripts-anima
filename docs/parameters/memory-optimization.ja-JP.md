# VRAM と速度

読み込み・キャッシュ・学習・プレビューのうち、不足する段階に合わせて設定を選びます。実測は同梱エンジンと同じ上流リビジョンに基づき、各節に出典を記載しています。解像度、batch、rank、アテンションの実装、量子化を合わせて比較してください。

<!-- doc-anchor: overview -->
## ボトルネックに合わせて選ぶ

| 状況 | 最初に確認する項目 | 主な負担 |
| --- | --- | --- |
| 学習中に VRAM が不足 | バッチ、解像度、勾配チェックポイント、キャッシュ | 再計算や処理時間の増加。解像度は学習内容にも影響 |
| 凍結した重みの常駐量が大きい | ブロックスワップ、MOSS の ConvRot INT8 | RAM、転送、量子化誤差の増加 |
| テキストキャッシュ生成時に不足 | MOSS のテキストエンコーダー層スワップ、INT8 | スワップによるキャッシュ生成の低速化、量子化によるモデルの数値の変化 |
| VAE のエンコード／デコード時に不足 | Anima 2D VAE、VAE バッチ、プレビュー寸法 | エンコード速度やプレビュー寸法の変化 |
| 安定して学習でき、VRAM に余裕がある | チェックポイントを省く末尾ブロック数を増やす | VRAM を使って再計算を減らす |

キャッシュ、数ステップの学習、プレビューまで完了してから、一項目ずつ変更します。最大 bucket とプレビュー用に約 1〜2 GB の余裕を残します。LoRA のオプティマイザ状態は基礎重みや活性値より小さいことが多く、選び方は[オプティマイザの説明](optimizers.ja-JP.md#optimizer-type)にあります。

<!-- doc-anchor: partial-checkpointing -->
## チェックポイントを省く末尾ブロック数

勾配チェックポイントの有効時に `gradient_checkpointing_skip_blocks=N` を指定すると、末尾 N 個のメインブロックの活性値を保持し、逆伝播時の再計算を省きます。N が大きいほど VRAM を使い、通常はステップ時間が短くなります。`0` は全メインブロックをチェックポイント化します。範囲は Anima が `0〜28`、MOSS が `0〜42`。MOSS のテキスト埋め込みブロックは引き続きチェックポイントを使います。

まず `0` で動作を確認し、数ブロックずつ増やして安定時のステップ時間とピーク VRAM を比較します。以下の構成では、上流はバッチを増やすよりも省略ブロック数を増やす方が余剰 VRAM を活用しやすいとしています。[H2D-only スワップ](#h2d-only)では、省略数かスワップ数の少なくとも一方がリングスロット数以下である必要があります。

### Anima：上流の実測

約 1 MP の画像、batch 1、LoRA dim 16、bf16、Flash Attention、latent とテキスト出力をキャッシュ。学習中の `nvidia-smi` ピークです。2 枚の GPU は同じ学習設定を使っています。

| 省略ブロック数 | PRO 6000 Blackwell VRAM | ステップ時間 | RTX 4090 VRAM | ステップ時間 |
| --- | --- | --- | --- | --- |
| 0 | 6.5 GB | 0.85 s | 6.7 GB | 0.73 s |
| 7 | 9.4 GB | 0.75 s | 9.6 GB | 0.68 s |
| 14 | 12.9 GB | 0.73 s | 13.0 GB | 0.63 s |
| 21 | 16.4 GB | 0.59 s | 16.5 GB | 0.56 s |
| 28 | 19.9 GB | 0.53 s | 20.0 GB | 0.52 s |

この RTX 4090 の測定では、`0` から `28` に変えると時間が約 29% 減り、VRAM は約 13.3 GB 増えています。本トレーナーの既定 rank やアテンションの実装とは異なる場合があります。

出典：[Anima 上流ガイド・固定リビジョン](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md#71-vram-usage-optimization--vram使用量の最適化)。

### MOSS-Image：上流の実測

RTX PRO 6000 Blackwell、約 1 MP、batch 1、LoRA dim 16、Flash Attention、latent とテキスト出力をキャッシュ。INT8 側は `compile` も有効で、コンパイルと autotune のウォームアップ後の時間です。量子化とコンパイルを合わせた構成として比較します。

| 省略ブロック数 | bf16 VRAM | ステップ時間 | ConvRot INT8 + compile VRAM | ステップ時間 |
| --- | --- | --- | --- | --- |
| 0 | 13.5 GB | 1.29 s | 10.0 GB | 0.84 s |
| 11 | 23.4 GB | 1.21 s | 15.4 GB | 0.79 s |
| 21 | 33.6 GB | 1.13 s | 21.9 GB | 0.74 s |
| 32 | 44.9 GB | 1.02 s | 29.1 GB | 0.70 s |
| 42 | 55.0 GB | 0.93 s | 35.5 GB | 0.64 s |

上流の起動ピークの説明はこの表と一致しないため、公表値をそのまま掲載しています。起動時は[段階別実測](#memory-phases)も確認してください。

RTX 4090、画像／batch／rank／アテンションは同条件、テキストエンコーダーは ConvRot INT8：

| DiT 構成 | 省略数 | ピーク VRAM | ステップ時間 |
| --- | --- | --- | --- |
| bf16 | 0 | 14.3 GB | 1.88 s |
| bf16 | 5 | 17.6 GB | 1.83 s |
| bf16 | 10 | 22.5 GB | 1.77 s |
| INT8 + compile | 0 | 10.0 GB | 1.00 s |
| INT8 + compile | 7 | 13.0 GB | 0.98 s |
| INT8 + compile | 14 | 17.5 GB | 0.94 s |
| INT8 + compile | 21 | 22.0 GB | 0.90 s |

出典：[MOSS 上流の実測と条件・固定リビジョン](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#71-vram-usage-optimization--vram-使用量の最適化)。

<!-- doc-anchor: checkpointing -->
## 勾配チェックポイント

`gradient_checkpointing` は逆伝播用に保持する中間活性値を減らし、その分を再計算します。主に学習時に作用します。読み込みやテキストキャッシュ生成で不足する場合は、その段階の設定を調整します。学習 VRAM が厳しいときは最初に有効にし、バッチと解像度も確認してください。

Anima / MOSS の H2D-only はチェックポイントが必須です。余裕があれば[部分チェックポイントの実測](#partial-checkpointing)を参考に再計算を減らします。CPU と Unsloth の設定は[活性値オフロード](#activation-offload)を参照してください。

<!-- doc-anchor: block-swap -->
## ブロックスワップ：重みの常駐量を減らす

`blocks_to_swap` は一部のメインブロックの重みを CPU に置き、必要なとき GPU へ転送します。増やすと重みの常駐 VRAM が減り、RAM と転送負荷が増えます。Anima の上限は `26`、MOSS は `40`。Krea 2 は自身のモデルと画面上限を使います。

Anima / MOSS では、CPU および Unsloth の活性値オフロードと併用できません。チェックポイントを有効にし、RAM の余裕を見ながらスワップ数を増やします。スワップ時は `compile_fullgraph` を無効にしてください。コンパイルの速度改善も小さくなる場合があります。

[H2D-only](#h2d-only)とも比較できます。MOSS の VRAM / RAM は[段階別実測](#memory-phases)を参照してください。

<!-- doc-anchor: h2d-only -->
## H2D-only・リングバッファ・ピン留めメモリ

Anima / MOSS の `block_swap_h2d_only` は、基礎重みを凍結する CUDA 学習で GPU→CPU の重み転送を省きます。`blocks_to_swap>0` と勾配チェックポイントが必須です。リングバッファは追加 VRAM を使います。`block_swap_ring_size=2` は転送と計算を重ね、`1` は重ねずに VRAM を抑えます。

同じスワップ数では従来方式より VRAM が増える場合があります。同程度に抑えるには、画面上限内でスワップ数を増やすかスロットを減らします。部分チェックポイントと併用する場合、**省略ブロック数 ≤ スロット数、またはスワップ数 ≤ スロット数**が必要です。

`use_pinned_memory_for_block_swap` は CPU 上の重みコピーをページロックします。転送が速くなる可能性がありますが、Windows の共有 GPU メモリと RAM の負担が増えます。H2D-only でのみ作用し、オフでも小さなピン留め転送用プールを使います。

上流 MOSS、RTX 3090、PCIe Gen3 x4、bf16、1024²、batch 1、36 ブロックのスワップ：

| 方式 | VRAM | ステップ時間 |
| --- | --- | --- |
| 従来方式 | 個別の記載なし | 11.7 s |
| H2D-only + ピン留め | 約 7 GB | 9.4 s |

PCIe 帯域と電力制限で速度が変わります。

出典：[上流ブロックスワップガイド・固定リビジョン](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)。

<!-- doc-anchor: activation-offload -->
## 活性値オフロード

CPU オフロード（`cpu_offload_checkpointing`）と Unsloth 非同期オフロード（`unsloth_offload_checkpointing`）は、チェックポイントの活性値を RAM に移します。VRAM が減る一方、RAM と転送が増えます。通常のチェックポイント後も活性値が制約になる場合に比較します。

Anima / MOSS ではこの 2 方式は排他で、`blocks_to_swap>0` とも併用できません。スワップ構成と活性値オフロード構成のピーク VRAM、RAM、安定したステップ時間を比べて選びます。Krea 2 の `gradient_checkpointing_cpu_offload` は別エンジンの設定で、その学習タイプの画面制約に従います。

上流 MOSS の INT8 構成の一例では、Unsloth 使用時の学習ピークは `8.2 GB`、オフ時は `9.1 GB` でした。条件は[段階別実測](#memory-phases)に記載しています。

<!-- doc-anchor: caching -->
## Latent とテキスト出力のキャッシュ

`cache_latents` は VAE のエンコード結果、`cache_text_encoder_outputs` はテキスト出力を再利用し、学習中に対応するエンコーダーを GPU から外せます。ディスクキャッシュは実行をまたいで再利用でき、常駐キャッシュ RAM も抑えますが、保存領域と読み取りが必要です。

初回キャッシュ生成では VAE／テキストエンコーダーを動かします。MOSS のテキストキャッシュには[エンコーダー層スワップ](#text-encoder-swap)も利用できます。

Latent キャッシュはランダムクロップと競合します。テキストキャッシュは対象エンコーダーの凍結が必要で、タグのシャッフル、タグ単位の dropout、token warm-up など動的な説明文処理を制限します。学習タイプの画面表示を確認してください。画像、重み、説明文、関連する前処理を変えた場合は対象キャッシュを作り直します。

<!-- doc-anchor: text-encoder-swap -->
## MOSS のテキストエンコーダー層スワップ

`text_encoder_blocks_to_swap` はテキストキャッシュ生成中に Qwen3.5-9B の層を CPU から転送します。範囲は `0〜32`、`0` は無効、`32` は全層をストリーミングします。キャッシュ時のピークを減らしますが、PCIe 転送と RAM が必要で、エンコーダーは凍結する必要があります。本トレーナーの MOSS はエンコーダーを凍結しています。

上流の約 2000 token、説明文 1 件のテキストキャッシュ実測：

| エンコーダー | スワップ層数 | GPU 割り当てピーク（PyTorch） |
| --- | --- | --- |
| bf16 | 28 | 5.1 GB |
| bf16 | 32 | 3.5 GB |
| ConvRot INT8 | 32 | 2.2 GB |

ドライバー全体の占有量は含みません。上流では独立したテキストキャッシュツールを使い、層スワップなしのドライバーによるピークも測定しています。

| エンコーダー | GPU ピーク（nvidia-smi） |
| --- | --- |
| bf16 | 15.5 GB |
| ConvRot INT8 | 8.3 GB |

2 つの表は測定条件と集計方法が異なります。MOSS の `text_encoder_batch_size` はキャッシュ時に一度に扱う説明文の数を指定します。エンコーダーは常に 1 件ずつ処理するため、主にループの単位が変わります。

出典：[MOSS 上流のキャッシュ実測](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#71-vram-usage-optimization--vram-使用量の最適化)。

<!-- doc-anchor: quantization -->
## MOSS ConvRot INT8

`convrot_int8` は DiT メインブロックの凍結した基礎 Linear 重みを量子化し、LoRA 分岐を学習しながら重み VRAM を減らします。`convrot_int8_text_encoder` は凍結エンコーダーを量子化し、上流ではモデルサイズが約 `15.9 GB` から `7.4 GB` になります。量子化済み ConvRot ファイルは自動判別し、bf16 ファイルは読み込み時に量子化できます。

融合 INT8 カーネルには現在の torch と互換性のある Triton が必要です。なければ一時的に bf16 に戻す経路を使い、重み VRAM は減っても遅くなる場合があります。`convrot_int8_bwd` は初回は `bf16` を維持してください。`int8` は入力勾配も量子化し、上流はチェックポイント使用時に明確な速度改善を確認していません。

量子化は基礎モデルの数値を変えるため、損失と保存結果を比較します。MOSS は FP8 非対応で ConvRot INT8 を使います。他の学習タイプの FP8 / GGUF は各バックエンドに従います。基礎 LoRA の事前マージと MOSS ConvRot INT8 には画面で検証される制約があります。

メモリは[段階別実測](#memory-phases)、INT8 とコンパイルを合わせた速度は[部分チェックポイント](#partial-checkpointing)を参照してください。

<!-- doc-anchor: memory-phases -->
## 起動・学習・システム RAM

上流 MOSS、Windows、RTX PRO 6000 Blackwell、1024²、batch 1、LoRA dim 16、AdamW、勾配チェックポイント、latent ディスクキャッシュ。下表は DiT のみを学習し、テキスト出力をキャッシュします。起動にはテキストキャッシュ生成を含み、スワップは従来方式です。

| DiT / エンコーダー | 追加設定 | 起動 GPU ピーク | 学習 GPU ピーク | CPU RAM ピーク |
| --- | --- | --- | --- | --- |
| bf16 / bf16 | なし | 15.3 GB | 13.2 GB | 17.2 GB |
| INT8 / INT8 | なし | 9.1 GB | 9.1 GB | 9.9 GB |
| INT8 / INT8 | 20 ブロックスワップ | 7.9 GB | 6.9 GB | 14.0 GB |
| INT8 / INT8 | 36 ブロックスワップ | 7.9 GB | 5.2 GB | 15.6 GB |
| INT8 / INT8 | Unsloth 活性値オフロード | 8.2 GB | 8.2 GB | 11.2 GB |
| bf16 / INT8 | 20 ブロックスワップ | 9.0 GB | 9.0 GB | 18.5 GB |

上流はテキストエンコーダーも学習する構成を測定しています。本トレーナーの MOSS はエンコーダーを凍結するため、次の 2 行は学習範囲による違いの参考です。

| DiT / エンコーダー | 学習範囲 | 起動 GPU ピーク | 学習 GPU ピーク | CPU RAM ピーク |
| --- | --- | --- | --- | --- |
| INT8 / INT8 | DiT + エンコーダー LoRA、テキストキャッシュなし | 17.1 GB | 17.1 GB | 8.4 GB |
| bf16 / bf16 | DiT + エンコーダー LoRA、テキストキャッシュなし | 32.4 GB | 32.4 GB | 16.1 GB |

GPU は CUDA コンテキストを含む `nvidia-smi` ピーク、CPU RAM はプロセスのワーキングセットです。Windows のコミット量はこれより大きく、上流 bf16 では約 `38 GB` の例があります。システム空きメモリとページファイルも確認してください。

8 GB GPU では、学習が約 5.2 GB でも起動中に不足する場合があります。上流の 8 GB 手順は独立したツールで先にキャッシュを作り、エンコーダー層スワップも使います。この画面のキャッシュスイッチは、段階を別プロセスへ自動分割しません。プレビューの追加ピークも確認します。

`lowram` はモデルをより多く GPU に置いてシステム RAM を節約する設定で、VRAM 使用量が増える場合があります。

出典：[MOSS 上流の段階別実測](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#measured-memory-usage--メモリ使用量の実測値)。

<!-- doc-anchor: vae -->
## VAE のエンコードとデコード

Anima の `qwen_image_vae_2d` は同じ VAE 重みを使い、単一画像を等価な 2D 経路で処理します。上流 RTX 3090、1024² を 10 枚エンコードした実測：

| VAE 経路 | GPU ピーク | エンコード時間 |
| --- | --- | --- |
| 3D | 約 4.4 GB | 7.7 s |
| 2D | 約 1.4 GB | 4.5 s |

上流の MOSS 独立 latent キャッシュツールは、FP32 VAE、1024² 画像で GPU 約 `3.2 GB` でした。Anima の比較とは VAE が異なります。

VAE の不足時はまず `vae_batch_size` を下げます。`vae_chunk_size` は Anima の空間分割ですが、2D 経路は全解像度の活性値やアテンションがピークを決めやすく、分割による削減は限定的です。`vae_disable_cache` は 3D VAE 内部の時間キャッシュ用で、2D 経路には作用しません。

SDXL の `no_half_vae` は VAE を FP32 で動かし、一部の精度問題を避けられますがメモリが増えます。MOSS は FLUX.2 VAE、Krea 2 は自身のキャッシュ／tiling 設定を使います。プレビューのデコードで不足する場合はプレビュー寸法も下げます。

出典：[Anima の VAE 設定](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)、[MOSS のキャッシュ実測](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#measured-memory-usage--メモリ使用量の実測値)。

<!-- doc-anchor: batch-resolution -->
## バッチ・解像度・勾配累積

`train_batch_size` は同時に処理する画像数で、増やすと通常は活性値 VRAM が増えます。不足時は `1` にし、`gradient_accumulation_steps` で必要な実効サンプル数を確保します。完全なバッチでは、更新あたり約 batch × 累積回数 × GPU 数です。

勾配累積は小さいバッチを複数回処理して一回の更新にまとめるため、全画像の活性値を同時には保持しません。ただし epoch 固定時の更新回数も変わります。画像あたりの時間、更新数、学習結果を合わせて比較してください。

`resolution` と実際の bucket が画像 token と活性値の規模を決めます。高解像度、最大 bucket、長い説明文、追加の学習対象はピークを上げる要因です。

<!-- doc-anchor: precision-attention -->
## 精度とアテンションの実装

`mixed_precision` は一部の計算精度を変えます。`full_bf16` はモデルと学習対象パラメータも BF16 にし、メモリを減らせる場合がありますが、パラメータ精度も下がります。対応オプティマイザを確認し、初回は学習タイプの既定値で比較用の基準を作ります。

SDPA、Flash Attention、xformers のメモリと速度は GPU、依存関係、入力長で変わります。上流表は Flash Attention を使い、本トレーナーの既定 `torch` / SDPA とは異なる場合があります。

`split_attn` は画像ごとにアテンションを処理し、長さの異なる説明文バッチの padding を減らせる場合があります。Anima / MOSS は xformers 時に自動で有効になります。効果はバッチと説明文長に依存し、batch 1 では除ける padding が少なくなります。

<!-- doc-anchor: compile -->
## コンパイルと VRAM

Anima / MOSS の `compile` は DiT ブロック単位でコンパイルします。初回のコンパイルと autotune が落ち着いてから時間を比べます。上流 MOSS の INT8 + compile は、省略ブロックあたりの保持活性値が約 `0.6 GB`、bf16 の測定では約 `1 GB` でした。条件は[部分チェックポイント実測](#partial-checkpointing)を参照してください。

コンパイルがピークやキャッシュ使用量を増やす場合もあります。スワップはコンパイル対象を制限するため、併用時は `compile_fullgraph` を無効にします。Krea 2 のコンパイル経路は独立しているので、その学習タイプの設定で測定します。
