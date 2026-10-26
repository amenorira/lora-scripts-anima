# AdaLN 変調層

<!-- doc-anchor: overview -->
## 変調層の役割

AdaLN は現在のノイズレベルに応じて特徴のスケール・オフセット・分岐の強さを調整し、ノイズ除去の各段階にモデルを適応させます。

オンにすると、現在の学習範囲に AdaLN 変調層のアダプタを追加し、パラメータ数と重みファイルのサイズが増えます。Anima の標準ネットワークでは既定でオフです。

<!-- doc-anchor: effects -->
## 学習範囲の変化

| 設定 | 学習対象 | 影響 |
| --- | --- | --- |
| オフ | 選択済みの Attention・MLP など | 標準の既定範囲では AdaLN 変調層を除外 |
| オン | 選択済みの範囲に AdaLN 変調層を追加 | 変調分岐のアダプタ、パラメータ数、ファイルサイズが増加 |

カスタムの包含ルールでも変調層を追加できます。実際の学習範囲は構造プレビューで確認してください。

<!-- doc-anchor: usage -->
## オンとオフを比較する

学習範囲を広げた効果を調べるには、データ、学習率、Rank、シード、総ステップ数を固定し、AdaLN だけを切り替えます。対象の特徴とプロンプトによる制御の両方を比較してください。

<!-- doc-anchor: default-behavior -->
## 上流実装の既定動作

Anima の標準ネットワークは、既定で `.*(_modulation|_norm|_embedder|final_layer).*` に一致する変調・正規化・埋め込み・出力層を除外します（`networks/lora_anima.py`。標準の LoHa / LoKr も `network_base.py` 経由で同じ設定を使います）。

スイッチをオンにすると、次の指定を `network_args` に追加します。

```text
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

この 3 つの変調分岐だけを除外の例外にします。追加引数に既存の `include_patterns` がある場合は 1 つの項目に統合します。正規化層・埋め込み層・最終層は引き続き除外します。

追加されるパラメータ数と推定ファイルサイズは、選択したアルゴリズム・ランク・学習範囲に応じて構造プレビューで確認できます。

<!-- doc-anchor: settings -->
## 他の設定との関係

| ネットワーク | 設定箇所 | 適用条件 |
| --- | --- | --- |
| Anima の標準ネットワーク | メインフォームの「AdaLN 層も学習」 | `networks.lora_anima`・`networks.loha`・`networks.lokr` に対応 |
| LyCORIS | LyCORIS 設定の AdaLN 項目 | `attn-mlp` プリセットを sd-scripts の既定範囲に合わせている場合 |

LyCORIS の `attn-mlp` は、既定では sd-scripts の範囲に合わせる設定がオフです。その場合は LyCORIS の対象層の設定で AdaLN の学習範囲が決まります。構造プレビューで対象を確認してください。
