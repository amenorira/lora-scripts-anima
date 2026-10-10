# LoRA+

> LoRA+ は指定したパラメータ群の学習率を上げ、パラメータ数を増やさずに学習を速めます。既定でオフです。比較は既定倍率の `2.0` から始め、最良のチェックポイントに早く到達するか確認してください。

<!-- doc-anchor: overview -->
## 概要

LoRA+ は LoRA の 2 つのパラメータ群に異なる学習率を使い、両者の学習速度のバランスを調整します。標準 LoRA では `lora_down` が基本学習率を使い、`lora_up` が基本学習率に倍率を掛けた値を使います。

高い倍率ほど学習率の差が広がり、`1.0` なら同じ学習率です。倍率が高すぎると、繰り返し登場する背景・服装・ポーズの暗記が早まる場合があります。

基本学習率が `2e-5` の例：

| 倍率 | `lora_down` の学習率 | `lora_up` の学習率 |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

基本学習率を上げると両群に影響します。LoRA+ の倍率を上げると指定した群だけに影響します。この 2 つは異なる調整です。

<!-- doc-anchor: good-cases -->
## 試す場面

基本設定の学習が安定していても、対象の特徴を覚えるのが遅い場合に試してください。損失が既に急増している場合は、倍率を比較する前に基本学習率を下げます。

<!-- doc-anchor: effects -->
## 学習対象ごとの確認

キャラクター・画風・服装・概念でグループ分けは同じです。対象の特徴がいつ現れ、新しいポーズや背景でも再現できるかを確認します。固定した構図も早く現れる場合は、倍率を下げるか早めに終了してください。

<!-- doc-anchor: ratio-guidance -->
## 倍率の選び方

`2.0` から始めます。学習が遅い場合は `4.0` と比較し、過学習が早まる場合は下げてください。

| 倍率 | 意味 | 注意点 |
| --- | --- | --- |
| `1.0` | 両群で同じ学習率 | LoRA+ の効果なし |
| `2.0` | 高学習率の群が 2 倍 | 本ツールの既定値。差は比較的小さい |
| `4.0` | 高学習率の群が 4 倍 | 基本値に対する実効学習率を確認 |
| `8.0`–`16.0` | 高学習率の群を大幅に増幅 | 基本学習率・停止時期・重複データの影響を受けやすい |

論文と sd-scripts 文書の倍率 `16` は、特定の実験に基づく値です。本ツールは穏やかな初期値として `2.0` を使います。

<!-- doc-anchor: parameters -->
## 設定項目

「LoRA+ を使用」は全体のスイッチです。下の倍率を学習設定に出力するかを決めるもので、スイッチ自体は学習引数ではありません。

オフでは倍率を出力しません。オンでは専用の倍率欄だけを使います。ネットワークの追加引数に同じ `loraplus_*` を指定しても除去され、専用欄を上書きできません。

以下はエクスポートされる学習用 TOML の例です。倍率は `network_args` に記述し、複数の倍率は 1 つのリストにまとめます。画面では専用欄を使ってください。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

コンポーネント別の指定がない場合に引き継ぐ共通倍率です。既定値 `2.0`、画面での最小値 `1.0`、刻み幅 `0.5` です。

```toml
network_args = ["loraplus_lr_ratio=2.0"]
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

UNet/DiT の倍率を上書きします。既定は空欄で、共通倍率を引き継ぎます。Anima の DiT バックボーンにも `unet` というパラメータ名を使います。

```toml
network_args = ["loraplus_unet_lr_ratio=2.0"]
```

テキストエンコーダだけを学習する場合は効果がありません。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

テキストエンコーダの LoRA の倍率を上書きします。既定は空欄で、共通倍率を引き継ぎます。

```toml
network_args = ["loraplus_text_encoder_lr_ratio=2.0"]
```

テキストエンコーダを学習する場合だけ適用します。UNet のみの学習やテキストエンコーダ出力のキャッシュ使用時は無効です。変更後はトリガーワードへの応答と、それ以外のプロンプトによる制御を確認してください。

コンポーネント別の倍率と共通倍率のどちらもない場合、そのコンポーネントに LoRA+ は適用しません。

| コンポーネント | 優先する設定 | 空欄の場合 |
| --- | --- | --- |
| バックボーン | バックボーンの LoRA+ 倍率 | LoRA+ の共通倍率 |
| テキストエンコーダ | テキストエンコーダの LoRA+ 倍率 | LoRA+ の共通倍率 |

<!-- doc-anchor: effective-lr -->
## 実効学習率

倍率は基本学習率と合わせて判断します。まず学習するコンポーネントの基本学習率を決め、その高学習率グループに倍率を適用します。

| コンポーネント | 優先する基本学習率 | 空欄の場合 |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| テキストエンコーダ | `text_encoder_lr` | `learning_rate` |

`unet_lr` または `text_encoder_lr` が指定されていれば、その値で計算します。例えば `learning_rate=1e-4`、`unet_lr=8e-5`、UNet/DiT の倍率 `2.0` の場合：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet の LoRA+ 実効学習率の例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<!-- doc-anchor: cautions -->
## リスクと制限

高い基本学習率と高い倍率を組み合わせると更新が強まり、暗記が早まるリスクが増えます。高倍率の比較では保存間隔を短くし、早い時点のチェックポイントも比較できるようにしてください。

<!-- doc-anchor: testing -->
## 結果の評価

学習速度と最終的な品質は別々に評価します。

| 比較 | 確認できること |
| --- | --- |
| 同じステップで保存したモデル | キャラクター・画風・概念を早く学べたか |
| 各実行の最良モデル | 到達できる最良の結果が改善したか |
| 新しいポーズ・背景・未学習の対象 | 学んだ特徴を柔軟に使えるか |

最良の結果に早く到達するだけなら、主な利点は学習ステップの削減です。対象と固定した構図が一緒に早く暗記される場合は、倍率と停止時期の両方を見直してください。

<!-- doc-anchor: optimizer-compatibility -->
## オプティマイザとスケジューラ

| オプティマイザ | LoRA+ の対応 | 注意点 |
| --- | --- | --- |
| AdamW・AdamW8bit・PagedAdamW8bit | 対応 | 群別の学習率を保持するため、倍率を確認しやすい |
| Lion・Lion8bit・PagedLion8bit | 対応 | 群別の学習率を保持 |
| CAME | 対応 | 群別の学習率を保持 |
| StableAdamW・Muon・Adan・AdEMAMix・AdEMAMix8bit・SOAP | 対応 | 群別の学習率を保持 |
| AdamWScheduleFree | 対応 | 群は保持するが、内部調整で実効学習率が変化 |
| Automagic3 | 条件付き | 基本学習率 × 倍率を `min_lr`～`max_lr` に収める。適応動作で実効倍率が変わる場合あり |
| AdaFactor | 手動学習率のみ | `relative_step` と `warmup_init` を両方オフにする。既定の相対ステップは群別学習率を使わないため、画面で LoRA+ を無効に固定 |
| Prodigy・ProdigyPlus | 未対応 | 現在の sd-scripts 経路では群別学習率を確実に保持できず、画面とバックエンドで拒否 |
| EmoSens | 未対応 | 共通の `emoPulse` で全パラメータを更新し、毎ステップ全群を同じ学習率に戻すため倍率が失われる |
| LoRA-Muon | 未対応 | 現在の共同更新実装には完全な LoRA 因子対が必要 |
| LoRA-RITE | 未対応 | 現在の因子対の処理が LoRA+ のグループ分けと非互換 |

非互換の方式に切り替えると LoRA+ をオフにし、理由を表示します。古いプリセットや直接の API 呼び出しによる組み合わせもバックエンドで拒否します。

通常のスケジューラでは各群を同じ比率で変化させるため、初期倍率を維持します。ウォームアップは学習開始時の全体の学習率を調整するもので、倍率ではありません。Schedule-Free や Automagic3 など内部で適応する方式は、学習中に記録した曲線を確認してください。

<!-- doc-anchor: support -->
## 対応するネットワーク

次のネットワークで LoRA+ スイッチを使えます。

| ネットワーク | 高学習率のパラメータ | 注意点 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 標準 LoRA+ のグループ分け |
| `networks.lora_anima` | `lora_up` | Anima 向け標準 LoRA+ |
| `networks.loha` | `hada_w2_a` | sd-scripts の LoHa 向け拡張 |
| `networks.lokr` | `lokr_w1` | sd-scripts の LoKr 向け拡張 |
| `lycoris.kohya`（LoCon / algo `lora` のみ） | `lora_up` など | LyCORIS は `lora_up` という名前で分類する。他のアルゴリズム（LoHa・LoKr など）は一致せず、倍率の効果なし |

標準 LoHa・LoKr は独自のグループ分けを使います。LyCORIS は LoCon（`lora`）だけに対応します。Krea 2（`networks.lora_krea2`、musubi-tuner 経路）は LoRA+ を提供しません。

<!-- doc-anchor: tensorboard -->
## TensorBoard

LoRA+ を有効にすると、sd-scripts は基本群と高学習率群を別々に記録します。標準の SDXL LoRA では通常、次の項目が現れます。

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

Anima のテキストエンコーダには番号が付き、通常は次の名前です。

```text
lr/textencoder 1
lr/textencoder 1 plus
```

`plus` が高学習率群です。ブロック別学習率など複数群の設定では、名前と曲線が増えます。

通常のオプティマイザでは 2 曲線の比で倍率を確認できます。適応型と Schedule-Free は内部でも更新を調整するため、専用の指標と生成サンプルも確認してください。

<!-- doc-anchor: mechanism -->
## 仕組み

標準 LoRA は層の重みの変化を小さな 2 行列で表します。`lora_down` は入力をランク次元へ射影し、`lora_up` は層の出力次元へ戻します。

入力 2048・出力 8192・ランク 32 の層の例：

```text
2048 特徴 → lora_down → 32 特徴 → lora_up → 8192 特徴
```

重みの変化は `ΔW = (Alpha / rank) × B × A` で、A が `lora_down`、B が `lora_up` です。

現在の sd-scripts は `lora_down` をランダムな値、`lora_up` をゼロで初期化します。最初の逆伝播では `lora_up` がゼロなので `lora_down` の勾配もゼロです。`lora_up` を更新した後に `lora_down` に非ゼロの勾配が流れ始めます。このため初期の更新動作は両行列で異なります。

通常の LoRA は両群に同じ学習率を使います。LoRA+ は `lora_down` の基本学習率を保ち、`lora_up` の学習率を上げます。

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ の学習率の式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

倍率は更新の大きさを変え、更新が始まる時点は変えません。`1.0` なら両群で同じ学習率です。

<!-- doc-anchor: faq -->
## よくある質問

**オンにすると結果が悪化したり、過学習が早まったりしました。**

オフにするか倍率を `1.0` に下げ、基本学習率・重複データ・停止時期を確認してください。

**実際に有効か確認するには？**

TensorBoard に `lr/unet` と `lr/unet plus` など、コンポーネントごとに 2 曲線が現れます。通常のオプティマイザなら両者の比が設定倍率に近くなるはずです。

**自動で無効になった理由は？**

オプティマイザとスケジューラの互換性の表を確認してください。画面に理由を表示し、未対応の組み合わせはバックエンドでも拒否します。

**テキストエンコーダだけの学習でも使えますか？**

テキストエンコーダだけに適用します。専用の倍率を優先し、空欄なら共通倍率を引き継ぎます。

<!-- doc-anchor: references -->
## 根拠と参考資料

設定の処理と互換性は `backend/training/adapter.py` と `optimizer_contracts.py` で定義しています。グループ分け・初期化・ログ名は同梱の `networks/lora.py`・`lora_anima.py`・`network_base.py` に実装されています。以下は固定リビジョンの参照先です。

- [本プロジェクトの sd-scripts フォーク：train_network_advanced.md（固定リビジョン）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [本プロジェクトの sd-scripts フォーク：loha_lokr.md（固定リビジョン）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
