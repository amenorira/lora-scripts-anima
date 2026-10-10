# タイムステップ

学習では、ノイズ量の異なる画像を処理する方法をモデルに学習させます。タイムステップは、入力画像のノイズ量を表します。ノイズが多いと元画像の情報が少ないため、画像全体の構造を組み立てる必要があります。ノイズが少ないと元画像がより多く残り、細部の調整が中心になります。

各範囲の役割は、次のように捉えられます。

| ノイズ量 | 主な役割 | 生成画像で確認する点 |
| --- | --- | --- |
| 高 | 全体の構造、ポーズ、構図、シルエット | 体の比率、ポーズ、全体の配置 |
| 中 | 全体と局所的な特徴のつながり | 同一性、形状、主要な特徴の一貫性 |
| 低 | 質感、線、輪郭、顔の細部 | 髪の毛、布の質感、筆致、小さな装飾品 |

これらの役割は重なります。キャラクターと画風のどちらを学習する場合も、複数のノイズ範囲を扱う必要があります。

タイムステップのサンプリングは、各ノイズ量を使う頻度を決めます。損失の重み付けは、選ばれた入力の予測誤差が学習損失に寄与する大きさを決めます。どちらも学習の重点を変えますが、作用する段階が異なります。

<!-- doc-anchor: quick-start -->
## 基準となる設定

最初は、選んだ学習プロファイルの既定値を使ってください。データ品質、キャプション、学習率、終了時点を確認しても構造や細部が不足する場合に、タイムステップを調整します。

<!-- doc-anchor: defaults -->
### プロファイルの既定値

| 学習プロファイル | サンプリング | 分布パラメータ | 損失の重み付け |
| --- | --- | --- | --- |
| Anima | `sigmoid` | `sigmoid_scale=1.0` | `uniform` |
| Krea 2 | `shift` | `sigmoid_scale=1.0`, `discrete_flow_shift=2.5` | `none` |

現在の実装では、`uniform` と `none` はどちらも、タイムステップごとの追加の損失重み付けを行いません。Krea 2 の `none` は、バックエンドと旧設定との互換性のために使われています。古いプリセットを読み込んだ場合は、フォームと分布プレビューに表示される値を確認してください。

どちらの既定値も複数のノイズ範囲を含み、キャラクター、画風、概念の初回学習に使えます。Krea 2 の固定シフトは、高ノイズ側の割合を増やします。これらの項目は学習フォームのタイムステップ／サンプリング設定にあります。

| 目的 | 調整する項目 | 既定値 |
| --- | --- | --- |
| 両端をより多くサンプリングする | `sigmoid_scale` | `1.0`。大きくすると両端に広がる |
| 高ノイズまたは低ノイズを増やす | `discrete_flow_shift` | Anima は `1.0`、Krea 2 は `2.5`。`shift` と `sigma` のみで有効 |
| サブセットごとにノイズ範囲を変える | `subset_timestep_offsets` | 未設定。Anima の一部のモードのみ対応 |
| 選ばれた入力の誤差の重みを変える | `weighting_scheme` | Anima は `uniform`、Krea 2 は `none`。どちらも等しい重み |

<!-- doc-anchor: terminology -->
## 3 種類の「ステップ」

この学習ツールでは、異なる 3 つの意味で「ステップ」を使います。

| 名称 | 意味 | 主なパラメータ |
| --- | --- | --- |
| 学習ステップ数 | LoRA のパラメータを更新した回数 | `max_train_steps` |
| 学習タイムステップ | 現在の画像に加えるノイズ量 | `timestep_sampling` |
| 生成ステップ数 | 画像生成に使うノイズ除去の計算回数 | `sample_steps` |

「学習ステップ 500」は、オプティマイザによる更新が 500 回行われたことを表します。Anima／Krea 2 のノイズタイムステップ `t≈500` は、画像とノイズの混合係数がそれぞれ約半分であることを表します。1 回の更新でも、画像ごとにタイムステップが選ばれます。

<!-- doc-anchor: visualizer -->
## 分布プレビュー

![ComfyUI テーマのタイムステップ分布プレビュー](../images/timestep-preview.ja-JP.jpg)

上の画像は設定例です。学習タイムステップのサンプリング項目にある **タイムステップ分布を表示** を開くと、現在の設定を確認し、基本分布と学習全体の分布を切り替えられます。サイドバーには、サンプリング設定、基本分布と現在の分布の中央値、損失の重み付けが表示されます。曲線にカーソルを合わせると、その位置の値を確認できます。

| 表示要素 | 読み方 |
| --- | --- |
| サンプリング曲線 | 幅が同じ区間では、曲線の下の面積が大きいほど、そのノイズ範囲が多く選ばれる |
| 高・中・低ノイズの割合 | 全体の再構成と細部の調整に割く機会を比較できる |
| 損失重みの曲線 | 入力が選ばれた後、その予測誤差に掛ける倍率 |
| 参照解像度 | 解像度に応じたシフトの計算に使う。データセット内のすべてのバケットを表すものではない |

曲線が示すのは、サンプリング頻度と損失の重みです。更新量や画質は示しません。離散的なノイズ表は、連続分布で近似して表示します。

横軸は画像生成のノイズ除去順に並びます。左端が最大ノイズ `t≈1000`（ほぼ純粋なノイズ、構造・構図を作る段階）、右端がノイズのない `t≈0`（細部を整える段階）です。

縦軸は確率密度 <var>f</var>(<var>t</var>) を表し、重みの曲線は対数目盛を使います。均一な重み付けでは、すべてのタイムステップに同じ倍率を掛けます。実際の損失は予測誤差によって変わります。

プレビューはサンプリングとシフトの式から直接計算するため、更新しても同じ結果になります。丸めにより、割合の合計が `99.9%` または `100.1%` になる場合があります。プレビューを開いても、学習は開始されず、設定も変更されません。

<span id="dataset-guidance"></span>
<span id="scenarios"></span>

<!-- doc-anchor: diagnosis -->
## 学習結果に応じた調整

不足する特徴が学習画像に含まれることを確認してから、次の方向を試してください。

| 症状 | 先に確認する点 | 試す調整 |
| --- | --- | --- |
| シルエットや体の比率が弱い | 全身画像と必要な視点の有無 | 高ノイズの割合を少し増やし、元の分布と比較する |
| 質感、線、装飾品が不足する | 元画像と学習解像度で細部が保たれるか | 低ノイズの割合を少し増やす。学習率と学習時間も確認する |
| 全体と細部の両方が弱い | 学習不足、学習対象の範囲が適切か | 分布を固定し、学習率、学習時間、学習範囲を確認する |
| 同じポーズや背景が繰り返される | 重複画像と過学習の兆候 | ノイズ範囲を変える前に、データと終了時点を確認する |
| 画風が色だけに反映され、形状に反映されない | 被写体と構図の多様性 | データが十分なら、全体構造を重視する分布と比較する |

1 回の学習で変えるタイムステップ設定は 1 つにし、複数の生成画像で比較してください。詳しい手順は「条件を揃えた比較」を参照してください。

<!-- doc-anchor: sampling -->
## `timestep_sampling`：ノイズ量を選ぶ頻度

`timestep_sampling` は、青いサンプリング密度曲線の基本形状を決めます。

| 選択肢 | 動作 | 対応モデル |
| --- | --- | --- |
| `sigmoid` | 中ノイズを多く選び、両端も含む | Anima、Krea 2 |
| `uniform` | 全範囲を均等に選ぶ | Anima、Krea 2 |
| `shift` | sigmoid 分布を作り、片側に移動する | Anima、Krea 2 |
| `sigma` | 学習スケジューラの離散ノイズ表から選ぶ | Anima、Krea 2 |
| `flux_shift` | 現在の解像度から FLUX 式のシフトを計算する | Anima |
| `krea2_shift` | 現在の解像度から Krea 2 式のシフトを計算する | Krea 2 |
| `logsnr` | LogSNR の分布をタイムステップに変換する | Krea 2 |

### `sigmoid`

`sigmoid_scale=1.0` でシフトがない場合、分布は左右対称で、中ノイズ付近に集中します。プレビューを等幅の 3 区間に分けると、低・中・高ノイズの割合は約 24.4%、51.2%、24.4% です。

標準正規分布から乱数を取り、`0–1` に変換します。

<div class="doc-equation" role="group" aria-label="sigmoid によるタイムステップのサンプリング式">
  <div class="doc-equation-kicker">Sigmoid サンプリング</div>
  <div class="doc-equation-expression"><var>z</var> ∼ N(0, 1)<br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(<var>s</var> · <var>z</var><span class="doc-math-close">)</span></div>
  <p><var>s</var> は <code>sigmoid_scale</code> です。既定値は 1.0 です。</p>
</div>

### `uniform`

タイムステップの全範囲を均等に選びます。既定の sigmoid 分布より、低ノイズと高ノイズの両端を多く学習します。

両端の学習機会を増やしたい場合に、sigmoid と比較してください。

### `shift`

sigmoid 分布に `discrete_flow_shift` を適用し、低ノイズ側または高ノイズ側へ重点を移します。

### `sigma`

学習スケジューラの離散ノイズ表から値を選びます。`discrete_flow_shift` はこの表を変えます。

`weighting_scheme=logit_normal` または `mode` は、表のインデックスを選ぶ頻度を変えます。それ以外はインデックスを均等に選びます。固定シフトで表のノイズ値が変わるため、インデックスが均等でもタイムステップが均等とは限りません。`sigma_sqrt` と `cosmap` は損失の重みだけを変えます。

### `flux_shift` と `krea2_shift`

潜在空間のグリッドサイズからシフトを計算します。グリッドの位置数が多いほど、高ノイズ側の割合が増えます。どちらも固定値 `discrete_flow_shift` は使いません。

バケットを有効にすると、解像度や縦横比の近い画像がまとめられます。バケットごとに潜在空間の寸法が異なるため、1 つの参照解像度のプレビューでは、すべてのバケットを表せません。

### `logsnr`

`logit_mean` の既定値は `0` です。大きくすると低ノイズ、小さくすると高ノイズが増えます。`logit_std` の既定値は `1` です。大きくすると分布が広がり、小さくすると集中します。`sigma + logit_normal` と名前は共通ですが、変換式が異なるため、値をそのまま流用できません。

SNR は信号とノイズの強度比で、LogSNR はその対数です。LogSNR が高いほど画像の信号が強く、ノイズが少なくなります。

Krea 2 の `logsnr` は、`logit_mean` と `logit_std` で定義した分布から LogSNR を選び、タイムステップに変換します。

<div class="doc-equation" role="group" aria-label="LogSNR からタイムステップへの変換式">
  <div class="doc-equation-kicker">Krea 2 の logsnr サンプリング</div>
  <div class="doc-equation-expression">LogSNR ∼ N(<var>μ</var>, <var>σ</var><span class="doc-math-close">)</span><br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(−LogSNR / 2)</div>
  <p><var>μ</var> は <code>logit_mean</code>、<var>σ</var> は <code>logit_std</code> です。</p>
</div>

<!-- doc-anchor: sigmoid-scale -->
## `sigmoid_scale`：分布の広がり

既定値は `1.0` です。大きくすると両端、小さくすると中央付近のサンプルが増えます。

| 調整 | 分布の変化 | 学習への影響 |
| --- | --- | --- |
| 小さくする | 中ノイズ付近に集中する | 両端が減り、ノイズ除去の中間段階を重視する |
| 大きくする | 低ノイズと高ノイズが増える | 細部の調整と全体の再構成を学習する機会が増える |

この表は追加シフトのない sigmoid 分布についての説明です。固定シフト、解像度によるシフト、サブセットのオフセットがある場合は、プレビューで最終的な割合を確認してください。

片側だけを増やすには、タイムステップのシフトを調整します。

<!-- doc-anchor: flow-shift -->
## `discrete_flow_shift`：分布全体の移動

既定値は Anima が `1.0`、Krea 2 が `2.5` です。大きくすると高ノイズ、小さくすると低ノイズが増えます。`0` より大きい値を指定してください。`shift` と `sigma` のみで有効です。

| 値 | 移動方向 | 比較する学習の重点 |
| --- | --- | --- |
| 1 より大きい | 高ノイズが増える | 全体構造、ポーズ、構図 |
| 1 | 固定シフトなし | 基本分布 |
| 0 より大きく 1 より小さい | 低ノイズが増える | 質感、線、細部 |

シフト値を <var>s</var> とすると、変換式は次のとおりです。

<div class="doc-equation" role="group" aria-label="discrete flow shift の式">
  <div class="doc-equation-kicker">固定フローシフト</div>
  <div class="doc-equation-expression"><var>t</var><sub>shifted</sub> = <span class="doc-frac"><span><var>s</var> · <var>t</var></span><span>1 + (<var>s</var> − 1) · <var>t</var></span></span></div>
  <p><var>s</var> は <code>discrete_flow_shift</code> です。</p>
</div>

固定シフトを読むのは `shift` と `sigma` だけです。`flux_shift` と `krea2_shift` は、解像度から独自のシフトを計算します。

<!-- doc-anchor: subset-offsets -->
## サブセット別のタイムステップオフセット

`subset_timestep_offsets` は、学習サブセットごとに分布を移動します。1 回の学習でも、顔のアップと全身画像に異なる分布を使えます。現在は **Anima のみ**対応し、Krea 2 と SDXL は非対応です。

サブセットは、数字とアンダースコアで始まるサブフォルダです（例：`10_face`、`3_full_body`）。先頭の数字はリピート回数です。UI と API では、全体に 1 つの値を指定するのではなく、サブセット名とオフセットの対応を指定します。

1. 数字とアンダースコアで始まるフォルダを作り、内容ごとに画像を分けます。
2. UI の対応表にフォルダ名とオフセットを入力します。
3. 分布プレビューで意図した変化を確認します。

対応表の例：

```json
{"10_face": -0.25, "3_full_body": 0.20}
```

学習開始時に、バックエンドが別の `dataset.toml` を書き出します。この項目はメインの学習設定には入りません。

```toml
[[datasets.subsets]]
image_dir = ".../10_face"
[datasets.subsets.custom_attributes]
timestep_sampling = { offset = -0.25 }
```

オフセットは各画像とともにバッチへ渡されます。`10_face` の画像は `-0.25`、`3_full_body` は `0.20` を使い、同じバッチに混在しても画像ごとの値を保ちます。正則化データには適用されません。

### 対応モードと推奨範囲

`sigmoid`、`shift`、`flux_shift` で有効です。`uniform` と `sigma` はこの値を読みません。API から渡しても学習は実行されますが、オフセットは作用しません。

最初は `-0.5`〜`+0.5` の範囲で試してください。アップや質感には小さな負の値、全身や構造を重視する画像には小さな正の値を試します。絶対値が大きいほど片側に偏ります。すでに高ノイズへシフトしている分布に正の値を加えると、低ノイズの割合がさらに減ります。

プレビューでは、基本分布（全オフセットが 0）、全体の分布、各サブセットを確認できます。1 つずつ調整し、既定値の学習結果と比較してください。オフセットは学習時のサンプリングだけに作用します。他の検証設定が同じなら、検証損失を比較できます。

### オフセットを加える位置

正規分布から取った乱数にオフセットを加え、`sigmoid_scale` を掛けてから `sigmoid` に通します。`shift` と `flux_shift` では、その後に分布全体を再変換します。

```text
timestep = sigmoid( sigmoid_scale × (random sample + offset) )
```

負の値は低ノイズ、正の値は高ノイズを増やし、`0` は元の分布を保ちます。`sigmoid_scale` は乱数とオフセットの両方に掛かります。

<!-- doc-anchor: weighting -->
## サンプリング頻度と損失の重み

サンプリングは「そのノイズ量を何回使うか」、損失の重み付けは「選ばれた後、その予測誤差をどれだけ重視するか」を決めます。低ノイズを多く選ぶ方法と、その損失の重みを増やす方法は、どちらも低ノイズ側を重視できますが、別の調整です。

| 方式 | 変わるもの | 意味 |
| --- | --- | --- |
| `uniform` / `none` | 追加の重み付けなし | 全タイムステップの損失重みは同じ。頻度はサンプリング方式で決まる |
| `sigma_sqrt` | 低ノイズの重みを増やす | 低ノイズの課題を重視する。ノイズが 0 に近いと重みが急増するため、更新の安定性を確認する |
| `cosmap` | 中ノイズの相対的な重みを増やす | 両端の重みを相対的に下げる。サンプリング頻度は変えない |
| `logit_normal` | `sigma` のサンプリング頻度 | 損失重みは追加しない。他のモードを logit-normal サンプリングにはしない |
| `mode` | `sigma` のサンプリング頻度 | 損失重みは追加しない。`mode_scale` が分布を調整する |

最初は `uniform` / `none` を使ってください。低ノイズの誤差を重視したいなら `sigma_sqrt`、中ノイズを重視したいなら `cosmap` を比較します。

### `sigma_sqrt` と `cosmap` の重み

<div class="doc-equation" role="group" aria-label="sigma sqrt による損失重み付けの式">
  <div class="doc-equation-kicker">低ノイズを重視</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>1</span><span><var>σ</var><sup>2</sup></span></span></div>
  <p><var>σ</var> が 0 に近づくと、重みが急増します。</p>
</div>

<div class="doc-equation" role="group" aria-label="cosmap による損失重み付けの式">
  <div class="doc-equation-kicker">中ノイズを重視</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>2</span><span><var>π</var> · (1 − 2 · <var>σ</var> + 2 · <var>σ</var><sup>2</sup><span class="doc-math-close">)</span></span></span></div>
  <p>両端の影響を相対的に減らし、中央を滑らかに重視します。</p>
</div>

<!-- doc-anchor: logit-normal -->
### `logit_normal`、`logit_mean`、`logit_std`

`weighting_scheme=logit_normal` は、`timestep_sampling=sigma` のときだけ有効です。

- `logit_mean` の既定値は `0`。表のインデックスが対称に分布します。大きくすると低ノイズ、小さくすると高ノイズが増えます。
- `logit_std` の既定値は `1`。小さくすると集中し、大きくすると両端へ広がります。

最終的な分布の位置は、スケジューラの固定シフトで決まります。`sigmoid + logit_normal` では、後者は頻度にも重みにも作用しません。Krea 2 の `logsnr` はこの 2 つの値を直接読むため、該当する説明を参照してください。

<!-- doc-anchor: mode -->
### `mode` と `mode_scale`

`mode` は `timestep_sampling=sigma` のときだけ頻度を変えます。損失重みは追加しません。

- `mode_scale=0`：ノイズ表のインデックスを均等に選びます。
- `0` から既定値 `1.29` へ大きくすると、表の中央付近に集中します。
- 中央が表すノイズ量は固定シフトで変わります。最初は `1.29` を使ってください。

<!-- doc-anchor: compatibility -->
## パラメータの有効範囲

| パラメータ | sigmoid | uniform | shift | sigma | flux/krea shift | logsnr |
| --- | --- | --- | --- | --- | --- | --- |
| `sigmoid_scale` | 有効 | 無効 | 有効 | 無効 | 有効 | 無効 |
| `discrete_flow_shift` | 無効 | 無効 | 有効 | 有効 | 無効 | 無効 |
| `logit_mean/std` | 無効 | 無効 | 無効 | `logit_normal` の密度のみ | 無効 | 直接使用 |
| `mode_scale` | 無効 | 無効 | 無効 | `mode` の密度のみ | 無効 | 無効 |
| `subset_timestep_offsets` | 有効 | 無効 | 有効 | 無効 | `flux_shift` のみ | 無効 |
| `sigma_sqrt/cosmap` の重み | 有効 | 有効 | 有効 | 有効 | 有効 | 有効 |

「無効」は、学習コードがその値を読まないことを表します。設定に残っていても作用しません。フォームでは無効な項目を隠すか注記し、プレビューでは無効な組み合わせを知らせます。

<!-- doc-anchor: sdxl-range -->
## SDXL の `min_timestep` と `max_timestep`

SDXL は、上記の Anima／Krea 2 用フローマッチング設定を使いません。代わりに、範囲を指定する項目があります。

- `min_timestep`：許可する最小タイムステップ。空欄は `0`。
- `max_timestep`：上限。この値自体は含みません。空欄は `1000` で、既定範囲は `0–999`。
- `min_timestep` を上げると、ノイズの少ないサンプルを除外します。
- `max_timestep` を下げると、ノイズの多いサンプルを除外します。

これらは許可範囲を狭める設定で、`sigmoid_scale` や `discrete_flow_shift` に相当するものではありません。既定値は全範囲を使います。片側を意図的に除外する実験で調整してください。

`min_snr_gamma`、`v_parameterization`、`zero_terminal_snr` も SDXL のノイズ学習に関係しますが、それぞれ損失の重み、予測対象、スケジューラの動作を変えます。ここで説明したフローマッチングの分布とは異なります。

<!-- doc-anchor: common-mistakes -->
## よくある誤解

- `sample_flow_shift` は生成プレビュー用で、学習タイムステップを変えません。
- シードは選ばれる乱数列を変えます。プレビューの理論分布は変えません。バッチサイズと GPU 数は短い学習でのばらつきに影響します。
- タイムステップ設定は LoRA のファイル形式を変えません。推論時に同じサンプラーを使う必要もありません。

<!-- doc-anchor: testing -->
## 条件を揃えた比較

1. **基準**：選んだプロファイルの既定値で 1 回学習します。
2. **固定する条件**：データセット、シード、rank、alpha、学習率、総学習ステップ数を揃えます。
3. **変更は 1 つ**：例として、`sigmoid_scale` だけを `1.0` から `1.25` に変えます。
4. **比較条件**：同じ学習ステップのチェックポイントを使い、プロンプト、生成シード、解像度、推論時の LoRA 強度を揃えます。
5. **評価項目**：再現性、背景の混入、構図の固定化、プロンプトへの追従、学習画像にない被写体や構図への対応を確認します。

学習損失は補助的な指標です。それだけで良し悪しを判断せず、条件を揃えた生成画像と実際の用途で評価してください。

<!-- doc-anchor: flow-matching -->
## タイムステップの仕組み

学習前に、VAE が画像を潜在表現へ変換します。モデルが扱うのはこの表現です。画像の潜在表現を <var>x</var>、ランダムノイズを <var>ε</var>、正規化したタイムステップを <var>t</var> とすると、ノイズを加えた入力は次のようになります。

<div class="doc-equation" role="group" aria-label="フローマッチングのノイズ付き入力の式">
  <div class="doc-equation-kicker">ノイズを加えた入力</div>
  <div class="doc-equation-expression"><var>x</var><sub>t</sub> = (1 − <var>t</var><span class="doc-math-close">)</span> · <var>x</var> + <var>t</var> · <var>ε</var></div>
  <p><var>t</var> が小さいほど元画像に近く、大きいほど純粋なノイズに近くなります。</p>
</div>

現在の Anima と Krea 2 は、データからノイズへ向かう方向を予測するように学習します。

<div class="doc-equation doc-equation-compact" role="group" aria-label="フローマッチングの学習対象">
  <div class="doc-equation-kicker">予測対象</div>
  <div class="doc-equation-expression"><var>v</var> = <var>ε</var> − <var>x</var></div>
  <p>生成時は、学習した経路を逆にたどり、高ノイズから画像へ向かいます。</p>
</div>

学習コードでは、ノイズの混合比を <var>σ</var> とも表します。`sigma_sqrt` と `cosmap` の sigma はこの値です。ここで扱うフローマッチングでは、<var>σ</var> と <var>t</var> は同じ方向に変わり、`0` に近いとノイズが少なく、`1` に近いとほぼ純粋なノイズになります。UI では、この範囲をおよそ `0–1000` のタイムステップとして表示します。

<!-- doc-anchor: evidence -->
## 実装と参考資料

式とパラメータの関係は、次のローカルファイルで確認できます。下のリンクは参照するリビジョンを固定しています。

- sd-scripts フォークの `library/flux_train_utils.py`：`sigmoid`、`shift`、`flux_shift` のサンプリング、`sigma_sqrt` と `cosmap` の重み、`discrete_flow_shift` の変換。
- Anima の `anima_train_network.py`：バッチの `custom_attributes` から画像ごとのオフセットを読み、学習時だけ適用。
- `backend/training/sd_dataset_config.py` と `backend/server/routes/training.py`：オフセットを検証し、別の `dataset.toml` を書き出して、`--dataset_config` で学習コードへ渡す。
- `library/anima_train_utils.py`：Anima のサンプリングと損失重み付けの振り分け。
- musubi-tuner フォークの `src/musubi_tuner/training/trainer_base.py`：Krea 2 の `krea2_shift` と `logsnr`。
- musubi-tuner フォークの `src/musubi_tuner/training/timesteps.py`：共通の密度と損失重みの式。
- `frontend/js/training-core.js`：確率密度の解析的な計算と、必要に応じた損失重みの曲線。

参考資料：

- [本プロジェクトの sd-scripts：`library/flux_train_utils.py`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/sd-scripts/library/flux_train_utils.py)
- [本プロジェクトの Anima 学習コード：`anima_train_network.py`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/sd-scripts/anima_train_network.py)
- [本プロジェクトのデータセット設定：`backend/training/sd_dataset_config.py`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/backend/training/sd_dataset_config.py)
- [本プロジェクトの sd-scripts：`library/anima_train_utils.py`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/sd-scripts/library/anima_train_utils.py)
- [本プロジェクトの musubi-tuner：`training/timesteps.py`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/musubi-tuner/src/musubi_tuner/training/timesteps.py)
- [本プロジェクトの musubi-tuner：`training/trainer_base.py`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/musubi-tuner/src/musubi_tuner/training/trainer_base.py)
- [本プロジェクトのフロントエンド：`training-core.js`](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/frontend/js/training-core.js)
- [Anima 公式モデルカード](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [Anima 開発元 Circlestone Labs の公式作例 LoRA：Greg Rutkowski Style - Anima](https://civitai.com/models/2536147/greg-rutkowski-style-anima)
- [Scaling Rectified Flow Transformers for High-Resolution Image Synthesis](https://arxiv.org/abs/2403.03206)
- [Flow Matching for Generative Modeling](https://arxiv.org/abs/2210.02747)
