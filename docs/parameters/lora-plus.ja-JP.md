<a name="guide-title"></a>
# LoRA+

> LoRA+ はアダプタの 2 つの低ランクパラメータ群に異なる学習率を割り当て、パラメータ数とファイルサイズはそのまま維持します。既定ではオフで、有効時の既定倍率は `2.0` です。

SDXL・Anima・MOSS-Image の[対応ネットワークモジュール](#support)、および Krea 2 のネイティブ LoRA・LyCORIS LoCon で利用できます。有効化する前に[オプティマイザ互換性](#optimizer-compatibility)を確認してください。

<a name="overview"></a>
## 概要・使いどころ・推奨倍率

<div id="mechanism"></div>

標準 LoRA は重み増分を `ΔW = (Alpha / Rank) × B × A` で表し、入力を Rank 次元へ射影する `lora_down`（`A`）をランダム値、出力次元へ戻す `lora_up`（`B`）をゼロで初期化します。最初のステップでは `lora_up` がゼロのため `lora_down` の勾配もゼロになり、学習序盤の両行列の更新スケールは非対称です。LoRA+ は `lora_down` を基本学習率に保ったまま、`lora_up`（ネイティブ LoHa / LoKr では対応する拡張パラメータ群）に指定倍率を掛けます。

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ の学習率の式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

基本学習率が `2e-5` の例（基本学習率自体を上げると両群が同時に強まりますが、倍率を上げると `lora_up` だけを加速できます）：

| 倍率（`ratio`） | `lora_down` の学習率 | `lora_up` の学習率 |
| --- | --- | --- |
| `1.0`（等学習率の基準） | `2e-5` | `2e-5` |
| `2.0`（既定の起点） | `2e-5` | `4e-5` |
| `4.0` | `2e-5` | `8e-5` |

<div id="good-cases"></div>
<div id="ratio-guidance"></div>

- **試す場面**：安全な基本学習率（`2e-5–1e-4` など）で顔立ち・衣装の細部・画風の収束が遅く、全体の学習率を引き上げるとベースモデルの破綻やノイズが出る場合に、基本学習率を据え置いたまま特徴の立ち上がりを早められます。
- **推奨倍率（`2.0–4.0`）**：まず既定の `2.0` をオフ（`1.0` 相当）と同一学習率・同一シードで比較してください。Krea 2 では `0.01–1.0` の正の倍率を指定して `lora_up` を基本学習率より低く抑えることも可能です。
- **過大な倍率（論文例の `16` など）への注意**：元論文や `sd-scripts` 文書にある `16` は、言語モデルやごく低い基本学習率（`~1e-5`）での実験値です。画像 LoRA の一般的な学習率（`5e-5–1e-4`）に `16` を掛けると `lora_up` が `8e-4–1.6e-3` に達し、序盤での色飽和・ポーズや背景の固定・トリガー以外のプロンプト追従低下を招きやすくなります。

<a name="parameters"></a>
## 設定項目と実効学習率

「LoRA+ を使用」がオフのときは倍率を出力せず、オンのときは専用の倍率欄が優先されます（SDXL・Anima・MOSS-Image では「ネットワークの追加引数」内の同名 `loraplus_*` を自動除去し、Krea 2 で旧設定を読み込む際は追加引数の共通倍率を画面項目へ移行します）。Krea 2 は共通倍率のみを提供するため、有効化する際は Rank と Alpha を手動指定し、「既存の重みから LoRA のランクを取得」をオフにしてください。

<a name="loraplus-lr-ratio"></a>
### `loraplus_lr_ratio`

共通倍率（既定値 `2.0`）です。バックボーンやテキストエンコーダの個別倍率が空欄のときに引き継がれます。

| モデル種別 | 画面の最小値 | 刻み幅 |
| --- | --- | --- |
| SDXL、Anima、MOSS-Image | `1.0` | `0.5` |
| Krea 2 | `0.01` | `0.1` |

<a name="loraplus-unet-lr-ratio"></a>
### `loraplus_unet_lr_ratio`

`sd-scripts` 経路で UNet / DiT バックボーンの倍率だけを上書きします（空欄時は `loraplus_lr_ratio` を使用。Anima・MOSS-Image の DiT バックボーンも内部引数名は `unet` です）。テキストエンコーダのみを学習する場合は無効です。

<a name="loraplus-text-encoder-lr-ratio"></a>
### `loraplus_text_encoder_lr_ratio`

`sd-scripts` 経路でテキストエンコーダ LoRA の倍率だけを上書きします（空欄時は `loraplus_lr_ratio` を使用）。テキストエンコーダを学習する場合のみ有効で、「UNet のみを学習」（Anima は「DiT のみを学習」）または「テキストエンコーダの出力をキャッシュ」がオンのときは機能しません（MOSS-Image と Krea 2 のテキストエンコーダは常に凍結されます）。変更後はトリガーワードの効きと他タグによる制御性を確認してください。

<a name="effective-lr"></a>
### 倍率の優先順と実効学習率の計算

`sd-scripts` 経路ではコンポーネントごとの基本学習率（`unet_lr` / `text_encoder_lr`、空欄なら `learning_rate`。Krea 2 は `learning_rate` を DiT の基本学習率として使用）を決めてから、**コンポーネント別倍率 → 共通倍率**の順で適用します。

| コンポーネント | 基本学習率の参照元 | 倍率の優先順 |
| --- | --- | --- |
| UNet / DiT バックボーン | `unet_lr`（空欄時は `learning_rate`） | `loraplus_unet_lr_ratio` → `loraplus_lr_ratio` |
| テキストエンコーダ | `text_encoder_lr`（空欄時は `learning_rate`） | `loraplus_text_encoder_lr_ratio` → `loraplus_lr_ratio` |

アプリから保存する設定ファイルは YAML 形式ですが、実行時に生成される `sd-scripts` 用の TOML では複数の倍率が 1 つの `network_args` リストにまとめられます。

```toml
network_args = [
  "loraplus_lr_ratio=2.0",
  "loraplus_unet_lr_ratio=3.0",
  "loraplus_text_encoder_lr_ratio=1.5",
]
```

たとえば `learning_rate=1e-4`、`unet_lr=8e-5`、バックボーン倍率 `2.0` の場合、バックボーン自身の `8e-5` を基準に計算されます。

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet の LoRA+ 実効学習率の例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<a name="optimizer-compatibility"></a>
## オプティマイザ互換性と対応ネットワーク

非互換のオプティマイザや自動調整モードを選ぶと、画面で LoRA+ が自動的にオフになり理由が表示されます（古いプリセットや API 経由の非互換な組み合わせもバックエンドで拒否されます）。

| オプティマイザ | LoRA+ の対応 | 注意点 |
| --- | --- | --- |
| AdamW・AdamW8bit・PagedAdamW8bit | 対応 | パラメータ群ごとの学習率を保持 |
| Lion・Lion8bit・PagedLion8bit・CAME | 対応 | パラメータ群ごとの学習率を保持 |
| StableAdamW・Muon・Adan・AdEMAMix・AdEMAMix8bit・SOAP | 対応 | パラメータ群ごとの学習率を保持 |
| AdamWScheduleFree | 対応 | グループ分けは保持しつつ、内部調整で実効更新幅が変化 |
| Automagic3 / Automagic4 | 条件付き | 倍率適用後の `plus` 群を含む全グループの初期学習率を `min_lr`〜`max_lr` 内に収める必要あり。学習中は各群が独立に調整される |
| AdaFactor | 手動学習率のみ | `relative_step` と `warmup_init` を両方オフにする必要あり。既定の相対ステップは群別学習率を無視するため画面で LoRA+ をロック |
| Prodigy・ProdigyPlusScheduleFree | 未対応 | 群別の学習率比率を確実に維持できないため、Krea 2 を含む全モデル種別で画面・バックエンドとも併用不可 |
| EmoSens | 未対応 | 単一の `emoPulse` で全パラメータを更新し、毎ステップ全群を同じ学習率へ戻すため倍率が失われる |
| LoRA-Muon・LoRA-RITE | 未対応 | 因子対の共同更新に完全な低ランク行列ペアが必要で、LoRA+ のグループ分割と非互換 |

Automagic では上限チェックに注意してください。たとえば開始学習率 `2e-5`・倍率 `12` では `plus` 群が `2.4e-4` となり、既定の `max_lr`（`2e-4`）を超えるため、倍率を下げるか `max_lr` を引き上げてから開始します。通常の外部スケジューラやウォームアップは全群に同じ係数を掛けるため、設定した倍率比は維持されます。

<a name="support"></a>
### 対応するネットワークモジュール

| ネットワークモジュール | 倍率を掛けるパラメータ群 | 対象と備考 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | SDXL 標準 LoRA |
| `networks.lora_anima` | `lora_up` | Anima ネイティブ LoRA |
| `networks.lora_generic` | `lora_up` | MOSS-Image ネイティブ LoRA |
| `networks.lora_krea2` | `lora_up` | Krea 2 ネイティブ LoRA |
| `networks.loha` | `hada_w2_a` | `sd-scripts` ネイティブ LoHa の拡張グループ分け |
| `networks.lokr` | `lokr_w1` | `sd-scripts` ネイティブ LoKr の拡張グループ分け |
| `lycoris.kohya`（LoCon / `lora` のみ） | `lora_up` など | Anima・Krea 2 の LyCORIS は LoCon モードのみ対応 |

<a name="testing"></a>
## 効果の評価・ログ確認・トラブルシューティング

<div id="cautions"></div>
<div id="effects"></div>

`2.0` を超える倍率を比較する際は保存間隔を短くし、「収束の早まり」と「到達品質の向上」を分けて確認します。

| 比較の切り口 | 確認できること |
| --- | --- |
| 同一ステップで保存したモデル | キャラクター・画風・概念がより早く立ち上がったか |
| 各実行のベストモデル同士 | 最終的に到達できる品質の上限が上がったか、早まっただけか |
| 新しいポーズ・背景・未学習の被写体 | 特徴の習得と同時に元画像の構図まで早く暗記していないか、プロンプト追従が落ちていないか |

<div id="faq"></div>

過学習が早まったり焼き付きが出たりした場合は、まず早いエポックのチェックポイントを確認し、改善しなければ倍率を `1.0–2.0` に戻したうえで基本学習率やデータセットの繰り返し数を見直してください。

<a name="tensorboard"></a>
### TensorBoard での確認

TensorBoard 記録を有効にすると、倍率を適用したパラメータ群に `plus` が付きます。

- **SDXL（バックボーン + テキストエンコーダ）**：`lr/unet`、`lr/unet plus`、`lr/textencoder`、`lr/textencoder plus` を記録。
- **Krea 2 / DiT のみの学習**：`lr/unet` と `lr/unet plus` を記録。
- **Anima（テキストエンコーダ学習時）**：番号付きの `lr/textencoder 1` と `lr/textencoder 1 plus` を記録（ブロック別学習率などの併用時はさらに曲線が増えます）。

通常のオプティマイザでは、学習率が非ゼロの区間で `plus / base` の比率が設定倍率と一致しているかを確認できます。内部で自動調整するオプティマイザでは群ごとに曲線が変化するため、生成サンプルとあわせて判断してください。

<div id="references"></div>

参考：[LoRA+ 原論文（arXiv:2402.12354）](https://arxiv.org/abs/2402.12354) · [sd-scripts `train_network_advanced.md`](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md) · [sd-scripts `loha_lokr.md`](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
