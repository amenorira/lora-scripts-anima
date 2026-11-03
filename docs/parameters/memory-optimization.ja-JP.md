# VRAM と速度の実測

<!-- doc-anchor: anima -->
## Anima

<!-- doc-anchor: anima-partial-checkpointing -->
### チェックポイントを省く末尾ブロック数

約 1 MP、batch 1、LoRA rank 16、bf16、Flash Attention。勾配チェックポイント、latent とテキストのキャッシュを使用。VRAM は学習中の nvidia-smi ピークです。

| 省略ブロック数 | PRO 6000 Blackwell VRAM | 秒/step | RTX 4090 VRAM | 秒/step |
| --- | --- | --- | --- | --- |
| 0 | 6.5 GB | 0.85 | 6.7 GB | 0.73 |
| 7 | 9.4 GB | 0.75 | 9.6 GB | 0.68 |
| 14 | 12.9 GB | 0.73 | 13.0 GB | 0.63 |
| 21 | 16.4 GB | 0.59 | 16.5 GB | 0.56 |
| 28 | 19.9 GB | 0.53 | 20.0 GB | 0.52 |

出典：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)

<!-- doc-anchor: moss -->
## MOSS-Image

<!-- doc-anchor: moss-partial-checkpointing -->
### チェックポイントを省く末尾ブロック数

#### RTX PRO 6000 Blackwell

約 1 MP、batch 1、LoRA rank 16、Flash Attention。勾配チェックポイント、latent とテキストのキャッシュを使用。INT8 + compile の時間はウォームアップ後です。

VRAM は CUDA コンテキストを含む学習中の nvidia-smi ピークです。bf16 エンコーダーでテキストをキャッシュする際の起動時ピークは約 15.6 GB です。

| 省略数 | bf16 VRAM | 秒/step | ConvRot INT8 + compile VRAM | 秒/step |
| --- | --- | --- | --- | --- |
| 0 | 13.5 GB | 1.29 | 10.0 GB | 0.84 |
| 11 | 23.4 GB | 1.21 | 15.4 GB | 0.79 |
| 21 | 33.6 GB | 1.13 | 21.9 GB | 0.74 |
| 32 | 44.9 GB | 1.02 | 29.1 GB | 0.70 |
| 42 | 55.0 GB | 0.93 | 35.5 GB | 0.64 |

#### RTX 4090

画像、batch、rank、アテンションと VRAM の測定方法は同条件。エンコーダーは ConvRot INT8 です。

| DiT 構成 | 省略数 | ピーク VRAM | 秒/step |
| --- | --- | --- | --- |
| bf16 | 0 | 14.3 GB | 1.88 |
| bf16 | 5 | 17.6 GB | 1.83 |
| bf16 | 10 | 22.5 GB | 1.77 |
| ConvRot INT8 + compile | 0 | 10.0 GB | 1.00 |
| ConvRot INT8 + compile | 7 | 13.0 GB | 0.98 |
| ConvRot INT8 + compile | 14 | 17.5 GB | 0.94 |
| ConvRot INT8 + compile | 21 | 22.0 GB | 0.90 |

#### ConvRot INT8 使用時の学習速度

RTX PRO 6000 Blackwell、1024×1024、batch 1、勾配チェックポイント。この比較の compile 状態、省略数、VRAM は未記載です。

| DiT 構成 | 秒/step |
| --- | --- |
| bf16 | 1.45 |
| ConvRot INT8 | 1.41 |

出典：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

<!-- doc-anchor: moss-block-swap -->
### スワップするブロック数

RTX PRO 6000 Blackwell、Windows、1024×1024、batch 1、LoRA rank 16、AdamW。勾配チェックポイントと latent ディスクキャッシュを使用。スワップは従来方式です。

| DiT / エンコーダー | 構成 | 起動 VRAM | 学習 VRAM | CPU RAM |
| --- | --- | --- | --- | --- |
| bf16 / bf16 | DiT のみ、テキストキャッシュ | 15.3 GB | 13.2 GB | 17.2 GB |
| ConvRot INT8 / ConvRot INT8 | DiT のみ、テキストキャッシュ | 9.1 GB | 9.1 GB | 9.9 GB |
| ConvRot INT8 / ConvRot INT8 | DiT のみ、テキストキャッシュ、20 ブロックスワップ | 7.9 GB | 6.9 GB | 14.0 GB |
| ConvRot INT8 / ConvRot INT8 | DiT のみ、テキストキャッシュ、36 ブロックスワップ | 7.9 GB | 5.2 GB | 15.6 GB |
| ConvRot INT8 / ConvRot INT8 | DiT のみ、テキストキャッシュ、Unsloth オフロード | 8.2 GB | 8.2 GB | 11.2 GB |
| bf16 / ConvRot INT8 | DiT のみ、テキストキャッシュ、20 ブロックスワップ | 9.0 GB | 9.0 GB | 18.5 GB |
| ConvRot INT8 / ConvRot INT8 | DiT + エンコーダー LoRA、テキストキャッシュなし | 17.1 GB | 17.1 GB | 8.4 GB |
| bf16 / bf16 | DiT + エンコーダー LoRA、テキストキャッシュなし | 32.4 GB | 32.4 GB | 16.1 GB |

VRAM は CUDA コンテキストを含む nvidia-smi ピークです。テキストキャッシュが有効な場合、起動時にはその作成も含みます。CPU RAM はプロセスのワーキングセットのピークです。末尾 2 行はテキストエンコーダーも学習する設定で、本トレーナーでは現在未対応です。

出典：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

#### 36 ブロックスワップ：従来方式と H2D-only

RTX 3090、PCIe Gen3 x4、bf16、1024×1024、batch 1。

| 方式 | VRAM | 秒/step |
| --- | --- | --- |
| 従来方式 | — | ≈ 11.7 |
| H2D-only + ピン留め | ≈ 7 GB | ≈ 9.4 |

—：上流に記載なし。

出典：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)

<!-- doc-anchor: moss-text-encoder-swap -->
### 転送するテキストエンコーダー層数

#### キャッシュ時の VRAM

約 2000 token の説明文 1 件。PyTorch の GPU 割り当てピークです。

| エンコーダー | 転送する層数 | GPU 割り当てピーク |
| --- | --- | --- |
| bf16 | 28 | 5.1 GB |
| bf16 | 32 | 3.5 GB |
| ConvRot INT8 | 32 | 2.2 GB |

#### 独立テキストキャッシュツール：層スワップなし

nvidia-smi で測定した VRAM ピークです。

| エンコーダー | ピーク VRAM |
| --- | --- |
| bf16 | 15.5 GB |
| ConvRot INT8 | 8.3 GB |

#### 層転送の所要時間

RTX PRO 6000、PCIe 5.0、bf16。この比較の説明文長は未記載です。

| 転送する層数 | 秒/説明文 |
| --- | --- |
| 0 | 0.1–0.3 |
| 28 | ≈ 0.7 |

出典：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)
