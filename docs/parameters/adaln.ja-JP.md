# AdaLN 変調層

<!-- doc-anchor: overview -->
## 変調層の役割

AdaLN は現在のノイズレベルに応じて特徴のスケール・オフセット・分岐の強さを調整し、ノイズ除去の各段階にモデルを適応させます。

AdaLN の学習を有効にすると、アダプタの対象をこれらの変調層まで広げます。形状・線・色・プロンプトへの応答に影響する場合があります。Anima の標準ネットワークでは既定でオフです。キャラクターや概念の LoRA はこの既定値から始め、画風の学習で基本の範囲では不足する場合に試してください。

| 設定 | 学習対象 | 影響 |
| --- | --- | --- |
| オフ | 選択済みの Attention・MLP など | AdaLN のパラメータはベースモデルの値を保持 |
| オン | 選択済みの範囲に AdaLN 変調層を追加 | 変更できる経路が増え、パラメータ数とファイルサイズが増加 |

<!-- doc-anchor: effects -->
## 学習への影響

AdaLN は学習可能な変調経路を追加します。タイムステップのサンプリングは変えません。形状・線・画風を比較し、プロンプトによる制御が保たれているかも確認してください。

<!-- doc-anchor: usage -->
## 使用の目安

- キャラクター・概念の LoRA：既定の範囲から始めます。対象の特徴を十分に学べている場合はオフのままにします。
- 画風の LoRA：データ・学習率・シードを揃え、AdaLN のオン・オフを比較してください。

<!-- doc-anchor: default-behavior -->
## 上流実装の既定動作

sd-scripts は LoRA の作成時に、組み込みの除外正規表現 `.*(_modulation|_norm|_embedder|final_layer).*` を適用し、変調層・正規化層・埋め込み層・最終層を除外します（`vendor/sd-scripts/networks/lora_anima.py`。LoHa・LoKr も `network_base.py` 経由で同じ Anima 設定を使います）。既定の LoRA が学習するのは Attention と MLP だけで、タイムステップから scale/shift/gate への写像はベースモデルのままです。

スイッチをオンにすると、次の指定を `network_args` に追加します。

```text
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

この 3 つの変調分岐だけを除外の例外にします。追加引数に既存の `include_patterns` がある場合は 1 つの項目に統合します。正規化層・埋め込み層・最終層は引き続き除外します。

追加されるパラメータ数と推定ファイルサイズは、選択したアルゴリズム・ランク・学習範囲に応じて構造プレビューで確認できます。

<!-- doc-anchor: settings -->
## 他の設定との関係

ネットワークごとに AdaLN の設定箇所が異なります。

| ネットワーク | 設定箇所 | 適用条件 |
| --- | --- | --- |
| Anima の標準ネットワーク | メインフォームの「AdaLN 層も学習」 | `networks.lora_anima`・`networks.loha`・`networks.lokr` に対応 |
| LyCORIS | LyCORIS 設定の AdaLN 項目 | `attn-mlp` プリセットを sd-scripts の既定範囲に合わせている場合 |

LyCORIS の `attn-mlp` は、既定では sd-scripts の範囲に合わせる設定がオフです。その場合は LyCORIS の対象層の設定と構造プレビューで AdaLN が含まれるか確認してください。メインフォームのスイッチでは制御しません。
