<a name="guide-title"></a>
# ネットワーク設定

ネットワーク設定はアダプタの行列分解方式、学習対象の範囲、保存される重みファイルのサイズを決めます。新規設定のドロップアウトは `0` で、Rank / Alpha の既定値はモデル種別ごとに決まります。

| モデル種別 | 既定の Rank / Alpha |
| --- | --- |
| Anima、SDXL、Krea 2 | `32 / 32` |
| MOSS-Image | `16 / 1` |

方式・Rank・分解係数・学習対象を変更した後は、[行列構造とファイルサイズ](matrix-preview.ja-JP.md)ダイアログで学習可能パラメータ数・実効スケール・`.safetensors` の推定サイズを確認してください。

<a name="algorithms"></a>
## LoRA・LoHa・LoKr

| 方式 | 重み増分の表現 | 特徴と選び方の目安 |
| --- | --- | --- |
| 標準 LoRA / LoCon | 2 つの低ランク行列の積 `B × A` | 推論環境の互換性が最も広く（ComfyUI・WebUI・Diffusers）、[LoRA+](lora-plus.ja-JP.md) や因子対オプティマイザ（`LoRA-Muon`・`LoRA-RITE`）にも対応。基本の選択肢として推奨 |
| LoHa | 2 組の低ランク行列積の要素積（Hadamard 積） | 同じ Rank でも実効ランクの上限が高い一方、**学習可能パラメータ数は標準 LoRA の約 2 倍**（同規模にそろえるなら Rank を半減）。複数概念や高密度な画風の検証向き |
| LoKr | 2 因子の Kronecker 積 `W1 ⊗ W2`（因子内部も低ランク分解可） | `lokr_factor` と Rank で形状を調整（Rank `8–16` が一般的な起点）。推論側が LyCORIS に対応していれば、軽量化と高ランク表現を両立しやすい |

モデル種別ごとに対応するネットワークモジュールは次のとおりです。

- **Anima・SDXL**：`sd-scripts` のネイティブモジュール（`networks.lora_anima` / `networks.lora`、`networks.loha`、`networks.lokr`）または `lycoris.kohya`（LoCon・LoHa・LoKr）。
- **MOSS-Image**：対象はすべて線形層で、ネイティブの `networks.lora_generic`・`networks.loha`・`networks.lokr` を使用。3 方式ともランク / モジュールドロップアウト、[LoRA+](lora-plus.ja-JP.md)、正規表現による層別の Rank / 学習率上書き（`network_reg_dims` / `network_reg_lrs`）、および任意の [DiT テキスト投影層と Refiner](#moss-text-embedder) に対応し、Qwen テキストエンコーダは凍結されます。
- **Krea 2**：ネイティブ LoRA（`networks.lora_krea2`）または LyCORIS（LoCon・LoHa・LoKr）で最大 264 個の DiT Linear 層を学習。絞り込み手順は [Krea 2 の学習対象と絞り込み](#krea-targets)を参照してください。

方式同士を比較する際は、まず[構造プレビュー](matrix-preview.ja-JP.md)で総学習パラメータ数をそろえ、同一プロンプト・同一シードで再現度と汎化性能を見比べてください（手順は[タイムステップガイド](timesteps.ja-JP.md#comparison-method)を参照）。

<a name="dimension"></a>
## Rank（ネットワークの次元）

`network_dim`（Rank）は低ランク分解の中間次元を指定します。既定値は Anima・SDXL・Krea 2 が `32`、MOSS-Image が `16` です。

| 用途・学習時の症状 | 標準 LoRA の目安 | 調整の考え方 |
| --- | --- | --- |
| 単一キャラクター・顔立ち・シンプルな小物 | `16–32`（LoKr は `8–16`） | 顔の特徴・髪型・1 着の衣装を十分に捉えつつ、ファイルサイズと過学習を抑えやすい |
| 複数衣装・複雑な画風・中〜大規模データセット | `32–64`（LoHa は `16–32`） | 多様な質感・ライティング・筆致の変化を保持する容量を確保できる |
| Rank が低すぎる（細密な対象で `4–8`） | `16–32` へ引き上げ | Loss が下げ止まっても目元・衣装の装飾・塗りの質感がぼやけ、学習不足が残る |
| Rank が高すぎる（15〜30 枚の少数画像で `64–128+`） | `16–32` へ引き下げ | ファイルとオプティマイザ状態が肥大化し、元画像のポーズ・背景・ノイズまで早く暗記しやすい |

<a name="alpha"></a>
## Alpha と rsLoRA

標準 LoRA は学習時・推論時とも行列積に `Alpha / Rank` を掛けて重み増分を計算します（パラメータ数やファイルサイズは変わりません）。

```text
ΔW = (Alpha / Rank) × B × A
```

Rank と学習率を固定したまま Alpha を下げると、1 ステップあたりの実効更新量と逆伝播勾配が抑えられ、同じ `ΔW` をより大きな内部重みで保持できます（Kohya 系ツールでは FP16 / BF16 保存時に微小な重みが `0` に丸められる損失を防ぐ目的でも導入されました）。Alpha を上げると実効的な更新強度が強まります。

<a name="alpha-choice"></a>
### よく使う値とショートカット

初回は既定値（Anima・SDXL・Krea 2 は `32 / 32`、MOSS-Image は `16 / 1`）のまま始め、既存のレシピを流用する場合は Rank・Alpha・学習率をセットで引き継いでください。標準 LoRA・Rank `32` の例：

| ボタン | Alpha | `Alpha / Rank` 倍率 | 選ぶ目安 |
| --- | --- | --- | --- |
| `= dim` | `32` | `1.0` | 追加の縮小を行わない標準的な起点 |
| `½ dim` | `16` | `0.5` | 序盤の更新を穏やかにし、収束を滑らかにしたいときの第一候補 |
| `1` | `1` | `1/32`（`0.03125`） | MOSS-Image 既定値や Alpha 1 系のレシピに合わせる場合 |

ショートカットボタンは押した時点の値を一度だけ入力します（後から Rank を変えても Alpha は自動追従しません）。一部のネイティブ実装では `Alpha = 0` を Rank と同値（倍率 `1.0`）として扱います。

<a name="alpha-lr"></a>
### 学習率との兼ね合い

AdamW などの適応型オプティマイザは勾配の一次・二次統計量で更新幅を正規化するため、実効的な学習速度は `Alpha / Rank` に単純比例しません。Alpha を `32` から `1` に下げたからといって、学習率をいきなり 32 倍に引き上げるのは避けてください。他の項目を固定したまま複数エポックのチェックポイントを同一シードで比較し、収束が明確に遅い場合のみ学習率を少しずつ上げ、序盤で色飽和やポーズ固定が出る場合は学習率を下げます。

<a name="rslora"></a>
### rsLoRA（ランク安定化スケーリング）

`rs_lora` を有効にすると、分母が `Rank` から `√Rank`（`ΔW = (Alpha / √Rank) × B × A`）に変わり、高 Rank で更新倍率が細る現象を抑えます。

オンに切り替えると実効倍率が大きく跳ね上がる点に注意してください。Rank `32` の場合、`Alpha = 32` のままだと倍率が `1.0` から **`√32 ≈ 5.66`** に増大し、`Alpha = 1` でも `0.03125` から **`≈ 0.177`** に上がります。`rs_lora` を使う際は必ず Alpha を下げる（`1` や `4–8` など）か学習率を落とし、序盤の発散や急激な過学習を防いでください。LoHa・LoKr のスケールは[構造プレビュー](matrix-preview.ja-JP.md)で確認でき、LoKr の完全因子時の挙動は[完全行列と両因子の分解](#full-matrix)を参照してください。

参考：[Kohya パラメータ解説](https://github.com/bmaltais/kohya_ss/wiki/LoRA-training-parameters#network-alpha) · [LoRA §4.1](https://arxiv.org/html/2106.09685v2#S4.SS1) · [rsLoRA](https://arxiv.org/html/2312.03732v1)

<a name="lokr-factor"></a>
## LoKr の分解係数（factor）

LoKr は 2 因子の Kronecker 積 `ΔW = scale × (W1 ⊗ W2)` で重み変化を表します。画面の `lokr_factor`（ネットワーク引数 `factor`）は `W1` と `W2` への次元配分を決め、Full Matrix モードでも有効です。`Rank`（`dim`）は因子内部をさらに低ランク分解する際の中間次元を指定します。

既定の `-1` は均等に近い次元分割を自動選択します。単一の `2048×2048` 線形層を完全因子・均等分割で表した場合の比較：

| `lokr_factor` | `W1` の形状 | `W2` の形状 | この層のパラメータ数 |
| --- | --- | --- | --- |
| `4` | `4×4` | `512×512` | `262,160` |
| `8` | `8×8` | `256×256` | `65,600` |

この例では `lokr_factor` を `4` から `8` に上げることでパラメータ数が 1/4 に減ります。各層の形状に応じて分割が変わるため、変更後は[構造プレビュー](matrix-preview.ja-JP.md)でアダプタ全体のサイズを確認してください。

<a name="full-matrix"></a>
## 完全行列と両因子の分解

LyCORIS LoKr の既定値は `full_matrix=false`、`decompose_both=false` です。`full_matrix` をオンにすると `W1`・`W2` の両方を完全行列として保持し、`decompose_both` は無視されます。オフの場合でも、層の `Rank ≥ max(dim1, dim2) / 2`（構造プレビューの「W2 の完全行列しきい値」）に達した因子は自動的に完全行列保持へ切り替わります。

| 設定の組み合わせ | `W1` の保持形式 | `W2` の保持形式 |
| --- | --- | --- |
| `full_matrix` オフ・`decompose_both` オフ | 完全行列 | しきい値未満は低ランク分解、しきい値以上は完全行列 |
| `full_matrix` オフ・`decompose_both` オン | 条件を満たせば低ランク分解 | しきい値未満は低ランク分解、しきい値以上は完全行列 |
| `full_matrix` オン | 完全行列 | 完全行列 |

両因子とも完全行列で保持される状態では、Rank をさらに上げても両因子のパラメータ数は増えませんが、LyCORIS LoKr のスケールは `rs_lora` に応じて変化します。

| 両因子が完全行列の場合 | 内部の Alpha | モジュールの `scale` |
| --- | --- | --- |
| `rs_lora=false` | `dim` に設定 | `1` |
| `rs_lora=true` | `dim` に設定 | `√dim` |

<div id="preview"></div>

分解設定を変更したら、[行列構造とファイルサイズ](matrix-preview.ja-JP.md)で「W2 を完全な行列で保持する層数」と各層の `scale` を確認してください。

<a name="unbalanced"></a>
## 非対称な因子分割

`unbalanced_factorization` は既定でオフです。オンにすると出力次元の 2 因数の割り当てを入れ替え、`W1` と `W2` の縦横比を変更します。特定の行列形状や圧縮率を比較する場合にのみ切り替え、[構造プレビュー](matrix-preview.ja-JP.md)でパラメータ数とスケールの両方を確認してください。

<a name="dora-bypass"></a>
## DoRA（重み分解）とバイパスモード

LyCORIS には、アダプタの適用経路を制御する `dora_wd`（DoRA 重み分解）と `bypass_mode`（バイパス順伝播）があります。

- **DoRA（`dora_wd`）**：更新後の重みを「方向」と出力チャネルごとの学習可能な「大きさ（ノルム）」に分解します。順伝播で `W + ΔW` を再構成してから方向を正規化するため、**`bypass_mode` をオフにする必要があり**、この重み再構成経路では通常の特徴 `dropout` は機能しません。
- **バイパスモード（`bypass_mode`）**：ベース重みと合成せず、別分岐で `W(x) + ΔW(x)` を計算します。量子化されたベース重みを順伝播で直接合成できない場合に必須となります。
- **量子化と方式の制約**：
  - **Anima（LyCORIS）**：Linear / Conv の LoCon・LoHa・LoKr は、`bypass_mode` がオフであれば DoRA を有効化できます。
  - **Krea 2（LyCORIS）**：`DiT の FP8 動的量子化`（`fp8_base`）または `ConvRot INT8`（`convrot_int8`）を有効にすると、強制的に `bypass_mode=true` になります。DoRA を使うには両方の量子化と `bypass_mode` をオフにし、LyCORIS LoCon では通常の `dropout` も `0` に保ってください（正の値を指定するとバイパス経路に切り替わります）。

<a name="dropout"></a>
## ネットワークとキャプションのドロップアウト

ドロップアウトは学習中の順伝播で特徴・低ランクチャネル・分岐・テキスト条件をランダムにマスクします（既定値はすべて `0` で、保存ファイルのパラメータ数は変わりません）。ポーズや背景の固定が見られる場合は、まず早いエポックのチェックポイントを見比べ、正則化を試すなら **`0.05–0.1`** 程度から始めます（`> 0.2` では収束の遅れや細部の甘さが出やすくなります）。

| 種類と設定キー | マスク対象 | 主な目的と注意点 |
| --- | --- | --- |
| 特徴ドロップアウト `network_dropout` | アダプタ中間特徴の要素 | 特定の特徴の組み合わせへの過度な依存を抑える |
| ランクドロップアウト `rank_dropout` | 低ランクチャネルの一部 | 少数のチャネルへの表現の偏りを防ぐ |
| モジュールドロップアウト `module_dropout` | 1 層のアダプタ分岐全体 | マスクされたステップではその層がベースモデルの出力をそのまま返す |
| 全文ドロップアウト `caption_dropout_rate` | プロンプト全体（SDXL） | 条件なし学習を混ぜる。`keep_tokens` でも全文の除外は防げない |
| タグドロップアウト `caption_tag_dropout_rate` | カンマ区切りの個別タグ | トリガー語と背景・衣装タグの癒着を緩める。`keep_tokens` で指定した先頭タグは保護される |

**テキストエンコーダ出力キャッシュとの排他制約**：`caption_tag_dropout_rate > 0`（または SDXL で `caption_dropout_rate > 0`）を設定すると、毎ステップ異なるタグの組み合わせを再エンコードする必要があるため、画面の**「テキストエンコーダの出力をキャッシュ」は自動的にオフで固定**され、VRAM 使用量とステップ時間が増加します。

Anima / SDXL の LyCORIS LoKr では、順伝播経路によって有効なドロップアウトも異なります（Krea 2 の LyCORIS LoKr 画面で設定できるのは `module_dropout` のみです）。

| LyCORIS LoKr の計算経路 | 通常の特徴 `dropout` | `rank_dropout` | `module_dropout` |
| --- | --- | --- | --- |
| バイパス出力（`bypass_mode=true`） | 有効（分岐出力に適用） | 未使用 | 有効 |
| 重み再構成（`bypass_mode=false`） | 未使用 | 有効（`ΔW` の出力チャネルをマスク） | 有効 |

<a name="krea-targets"></a>
## Krea 2：既定の学習対象と絞り込み

Krea 2 の既定 Rank / Alpha は `32 / 32` で、DiT の全 264 個の Linear 層（主ブロックの Attention・MLP・テキスト融合 Transformer・各種投影 MLP）を対象とします。テキスト融合は DiT 内部の層であり、Qwen テキストエンコーダは凍結されてキャッシュを使用します。変調パラメータと RMSNorm は生テンソルのため、Linear LoRA の対象外です。

ネイティブ LoRA と LyCORIS（LoCon・LoKr・LoHa）は共通の「学習対象層」セレクタを使います。

- **全 Linear（264 層）**：バックボーンに加え、入出力・時間投影・テキスト融合投影を含む全線形層。
- **バックボーン Attention（140 層）**：主ブロックの Attention 投影のみに絞り、ファイルサイズを最小化。
- **バックボーン Attention + MLP（224 層）**：主ブロックの主要変換層を網羅し、周辺投影とテキスト融合層を除外。
- **カスタム正規表現**：1 行 1 パターンで元の Linear 層名に完全一致させ、**除外パターンが包含パターンより優先**されます。たとえば `blocks\.[0-9]+\.attn\..*` を含めればバックボーン Attention のみを選択でき、`.*` を含めて `txtfusion\..*` を除外すればテキスト融合層だけを外せます。一致する層が 0 件の場合は起動前にエラーで停止します。

| Krea 2 のネットワーク方式 | ドロップアウトと LoRA+ の対応 |
| --- | --- |
| ネイティブ LoRA | `rank_dropout`・`module_dropout`・[LoRA+](lora-plus.ja-JP.md) に対応 |
| LyCORIS LoCon | 通常の `dropout`・`rank_dropout`・`module_dropout`・[LoRA+](lora-plus.ja-JP.md) に対応。[DoRA](#dora-bypass) 使用時は通常の `dropout` を `0` に設定 |
| LyCORIS LoHa | `rank_dropout`・`module_dropout` に対応 |
| LyCORIS LoKr | 現在の経路では `module_dropout` のみ提供 |

設定の保存・移行には `training.yaml` を使用してください（実行フォルダ内の対象プリセットは起動時に自動生成されます）。「全 Linear（264 層）」選択時は、従来のネイティブ LoRA 向けに「ネットワークの追加引数」で `exclude_patterns=['.*\.mlp\..*','first','last\.linear','tmlp\..*','txtmlp\..*','tproj\.1','txtfusion\..*']` を指定する書き方も互換維持されていますが（`include_patterns` は除外された層を戻す用途のみ）、新規設定では対象セレクタを直接使い、ネイティブ LoRA 用の引数を LyCORIS に混在させないでください。詳細は [Krea 2 の上流ガイド](https://github.com/kohya-ss/musubi-tuner/blob/f8a1b03794a49239a3539015075f5123d6c07d66/docs/krea2.md#lora-target-layers--loraの対象レイヤー)を参照してください。

<a name="moss-text-embedder"></a>
## MOSS のテキスト投影層と Refiner

MOSS-Image の `train_text_embedder` は既定でオフです。オンにすると、選択中の LoRA / LoHa / LoKr 方式で DiT 内部のテキスト入力投影層と 2 つの Refiner ブロックに **11 個のアダプタモジュール**を追加します（対象レイヤー数は `252` から `263` に増え、標準 LoRA・Rank 16・`bf16` では推定サイズが約 `71.0 MiB` から `74.4 MiB` になります）。Qwen テキストエンコーダ自体は凍結されたままなので、「テキストエンコーダの出力をキャッシュ」も引き続き併用できます。

これら 11 個のモジュールは既定でバックボーンの学習率を引き継ぎます。個別に `5e-5` などを指定したい場合は、「ネットワークの追加引数」に `network_reg_lrs=.*text_embedder.*=5e-5` を入力してください（全パラメータを単一の学習率で同期更新する `EmoSens` ではこの上書きは無効です）。Anima で Qwen3 を凍結したまま条件付けの学習範囲を広げたい場合は、画面の「LLM アダプタブロックも学習」スイッチおよび [AdaLN 変調層ガイド](adaln.ja-JP.md)を参照してください。
