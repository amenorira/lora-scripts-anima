# LoRA+

> LoRA+ はアダプタの 2 つのパラメータ群に異なる学習率を設定し、パラメータ数は維持します。既定でオフ、有効化したときの既定倍率は `2.0` です。

SDXL、Anima、MOSS-Image の対応ネットワークと、Krea 2 のネイティブ LoRA・LyCORIS LoCon で使えます。グループ分けは「対応するネットワーク」、オプティマイザの制約は互換性の表を参照してください。

<!-- doc-anchor: overview -->
## 概要

標準 LoRA では `lora_down` が基本学習率を使い、`lora_up` が基本学習率に倍率を掛けた値を使います。

`1.0` なら両群で同じ学習率です。Krea 2 では `1` 未満の正の倍率も指定でき、その場合の `lora_up` は基本値より低い学習率になります。

基本学習率が `2e-5` の例：

| 倍率 | `lora_down` の学習率 | `lora_up` の学習率 |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

基本学習率を上げると両群に影響します。LoRA+ の倍率を上げると指定した群だけに影響します。

<!-- doc-anchor: good-cases -->
## 試す場面

LoRA+ を使わない基準の結果ができたら、基本学習率と他の設定を固定して、倍率 `1` と `2` を比較します。同じステップでの結果と、各実行の最良結果が得られたステップを記録してください。

<!-- doc-anchor: ratio-guidance -->
## 倍率の選び方

既定の倍率 `2.0` と、両群で同じ学習率の `1.0` を比較します。他の倍率を試す際は基本学習率を固定し、上の例に従って倍率適用後の学習率を計算してください。

論文と sd-scripts 文書の `16` は、それぞれの実験で使った倍率です。本ツールの既定値は `2.0` です。比較する際は、それぞれの基本学習率も確認してください。

<!-- doc-anchor: parameters -->
## 設定項目

「LoRA+ を使用」がオフなら倍率を出力せず、オンなら専用の倍率欄を使います。SDXL、Anima、MOSS-Image は、追加引数の同名 `loraplus_*` を除去し、画面の値を優先します。Krea 2 は旧設定の追加引数にある共通倍率を画面の項目へ移行します。

以下はエクスポートされる学習用 TOML の例です。倍率は `network_args` に記述し、複数の倍率は 1 つのリストにまとめます。Krea 2 は共通倍率だけを提供します。LoRA+ を使う際は Rank と Alpha を手動で設定し、重みから次元を推定する設定をオフにしてください。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

共通倍率の既定値は `2.0` です。UNet/DiT とテキストエンコーダの個別倍率が空欄なら、この値を使います。

| 学習プロファイル | 画面の最小値 | 刻み幅 |
| --- | --- | --- |
| SDXL、Anima、MOSS-Image | `1.0` | `0.5` |
| Krea 2 | `0.01` | `0.1` |

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

UNet/DiT の倍率を上書きします。既定は空欄で、共通倍率を引き継ぎます。Anima と MOSS-Image の DiT 主幹にも `unet` というパラメータ名を使います。この項目は sd-scripts 経路用です。

テキストエンコーダだけを学習する場合は効果がありません。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

テキストエンコーダの LoRA の倍率を上書きします。既定は空欄で、共通倍率を引き継ぎます。

テキストエンコーダを学習する場合だけ適用します。UNet のみの学習やテキストエンコーダ出力のキャッシュ使用時は無効です。MOSS-Image と Krea 2 のテキストエンコーダは凍結します。変更後はトリガーワードへの応答と、それ以外のプロンプトによる制御を確認してください。

倍率は「コンポーネント別 → 共通倍率 → そのコンポーネントの LoRA+ を無効」の順に決まります。

| コンポーネント | 優先する設定 | 空欄の場合 |
| --- | --- | --- |
| バックボーン | バックボーンの LoRA+ 倍率 | LoRA+ の共通倍率 |
| テキストエンコーダ | テキストエンコーダの LoRA+ 倍率 | LoRA+ の共通倍率 |

sd-scripts で複数の倍率を出力する例：

```toml
network_args = [
  "loraplus_lr_ratio=2.0",
  "loraplus_unet_lr_ratio=3.0",
  "loraplus_text_encoder_lr_ratio=1.5",
]
```

<!-- doc-anchor: effective-lr -->
## 実効学習率

sd-scripts 経路では、各コンポーネントの基本学習率を決め、指定されたパラメータ群に倍率を適用します。

| コンポーネント | 優先する基本学習率 | 空欄の場合 |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| テキストエンコーダ | `text_encoder_lr` | `learning_rate` |

Krea 2 は `learning_rate` を DiT の基本学習率として使います。

`unet_lr` または `text_encoder_lr` が指定されていれば、その値で計算します。例えば `learning_rate=1e-4`、`unet_lr=8e-5`、UNet/DiT の倍率 `2.0` の場合：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet の LoRA+ 実効学習率の例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<!-- doc-anchor: cautions -->
## リスクと制限

高い倍率を比べる際は保存間隔を短くし、最良の結果が早まるか、後のチェックポイントでポーズや背景が固定されるか、プロンプトへの追従が低下するかを確認してください。

<span id="effects"></span>

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
| AdamW・AdamW8bit・PagedAdamW8bit | 対応 | 群別の学習率を保持 |
| Lion・Lion8bit・PagedLion8bit | 対応 | 群別の学習率を保持 |
| CAME | 対応 | 群別の学習率を保持 |
| StableAdamW・Muon・Adan・AdEMAMix・AdEMAMix8bit・SOAP | 対応 | 群別の学習率を保持 |
| AdamWScheduleFree | 対応 | 群は保持するが、内部調整で実効学習率が変化 |
| Automagic3 | 条件付き | 両群の初期学習率を `min_lr`～`max_lr` に収める。各群が独立に学習率を調整するため、初期の倍率関係は固定されない |
| AdaFactor | 手動学習率のみ | `relative_step` と `warmup_init` を両方オフにする。既定の相対ステップは群別学習率を使わないため、画面で LoRA+ を無効に固定 |
| Prodigy・ProdigyPlus | 未対応 | 現在の sd-scripts 経路では群別学習率を確実に保持できず、画面とバックエンドで拒否 |
| EmoSens | 未対応 | 共通の `emoPulse` で全パラメータを更新し、毎ステップ全群を同じ学習率に戻すため倍率が失われる |
| LoRA-Muon | 未対応 | 現在の共同更新実装には完全な LoRA 因子対が必要 |
| LoRA-RITE | 未対応 | 現在の因子対の処理が LoRA+ のグループ分けと非互換 |

非互換の方式に切り替えると LoRA+ をオフにし、理由を表示します。古いプリセットや直接の API 呼び出しによる組み合わせもバックエンドで拒否します。

本ツールの通常の外部スケジューラは各群に同じ倍率を掛け、初期の倍率関係を維持します。ウォームアップは初期の学習率を調整し、グループ分けは変えません。内部で自動調整するオプティマイザでは、ログの群別学習率と実際の更新尺度を区別してください。

<!-- doc-anchor: support -->
## 対応するネットワーク

次のネットワークで LoRA+ スイッチを使えます。

| ネットワーク | 倍率を適用するパラメータ | 注意点 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 標準 LoRA+ のグループ分け |
| `networks.lora_anima` | `lora_up` | Anima 向け標準 LoRA+ |
| `networks.lora_generic` | `lora_up` | MOSS 向け標準 LoRA+ |
| `networks.lora_krea2` | `lora_up` | Krea 2 のネイティブ LoRA のグループ分け |
| `networks.loha` | `hada_w2_a` | sd-scripts の LoHa 向け拡張 |
| `networks.lokr` | `lokr_w1` | sd-scripts の LoKr 向け拡張 |
| `lycoris.kohya`（LoCon / algo `lora` のみ） | `lora_up` など | Anima と Krea 2 の LoCon は `lora_up` という名前で分類 |

sd-scripts のネイティブ LoHa・LoKr は独自のグループ分けを使います。LyCORIS の LoRA+ は LoCon（`lora`）だけに対応します。

<!-- doc-anchor: tensorboard -->
## TensorBoard

LoRA+ を有効にし、主幹とテキストエンコーダの両方を学習すると、標準 SDXL LoRA は次の群名を記録します。

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

Krea 2 は DiT のみを学習し、LoRA+ が有効なら `lr/unet` と `lr/unet plus` を記録します。

Anima のテキストエンコーダ群には番号が付きます。このコンポーネントを学習すると、次の名前を記録します。

```text
lr/textencoder 1
lr/textencoder 1 plus
```

`plus` は倍率を適用する群です。ブロック別学習率など複数群の設定では、名前と曲線が増えます。倍率の確認方法は下の「よくある質問」を参照してください。

<!-- doc-anchor: mechanism -->
## 仕組み

標準 LoRA は層の重みの変化を小さな 2 行列で表します。`lora_down` は入力をランク次元へ射影し、`lora_up` は層の出力次元へ戻します。

入力 2048・出力 8192・ランク 32 の層の例：

```text
2048 特徴 → lora_down → 32 特徴 → lora_up → 8192 特徴
```

重みの変化は `ΔW = (Alpha / rank) × B × A` で、A が `lora_down`、B が `lora_up` です。

現在の sd-scripts は `lora_down` をランダムな値、`lora_up` をゼロで初期化します。最初の逆伝播では `lora_up` がゼロなので `lora_down` の勾配もゼロです。`lora_up` を更新した後に `lora_down` に非ゼロの勾配が流れ始めます。このため初期の更新動作は両行列で異なります。

LoRA+ がオフなら両群は同じ学習率です。オンでは `lora_down` が基本学習率を保ち、`lora_up` に指定した倍率を掛けます。

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ の学習率の式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

<!-- doc-anchor: faq -->
## よくある質問

**オンにすると結果が悪化したり、過学習が早まったりしました。**

オフにするか倍率を `1.0` に下げ、基本学習率・重複データ・停止時期を確認してください。

**実際に有効か確認するには？**

TensorBoard の記録を有効にし、学習中のコンポーネントの基本群と plus 群の曲線（例：`lr/unet` と `lr/unet plus`）を確認します。通常のオプティマイザで両群を学習していれば、学習率がゼロでない区間の比率は設定した倍率と一致します。適応型の群別学習率は各群の状態で変わるため、群ごとの曲線を専用指標と生成結果に合わせて評価してください。

<!-- doc-anchor: references -->
## 根拠と参考資料

sd-scripts の設定処理は `backend/training/config/adapter.py`、Krea 2 の倍率とネットワーク制約は `krea2_network.py`・`krea2_optimizers.py`、オプティマイザの互換性は `optimizer_contracts.py` に定義しています。グループ分け・初期化・ログ名は同梱の `networks/lora.py`・`lora_anima.py`・`network_base.py` に実装されています。以下のリンクはリビジョンを固定しています。

- [本プロジェクトの sd-scripts フォーク：train_network_advanced.md（固定リビジョン）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [本プロジェクトの sd-scripts フォーク：loha_lokr.md（固定リビジョン）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
