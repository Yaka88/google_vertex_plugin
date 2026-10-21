# GCP AI — Google Cloud 赠金与 Vertex 模型（Magpie 插件）

用你自己的 Google 账号登录一次，Magpie 里就会多出一行 **GCP AI**：

- **模型**：只列出你的项目实际能调用的 Vertex 模型，最新的排在最前面；
- **推理**：请求用你本机的 gcloud / ADC 凭证签名，账单进你自己的项目；
- **额度**：额度面板里显示 Google Cloud 的促销赠金（Promotional Credits）余额和到期时间。

不需要创建服务账号，也不需要下载 JSON 私钥。这一行和 Magpie 内置的 **Google Vertex AI** 行互不相干。

## 准备

- Google Chrome 或 Chromium
- Google Cloud CLI（`gcloud`），已经能正常使用
- 一个启用了 Vertex AI 的 Google Cloud 项目
- 查看赠金需要该账号对结算账号有查看权限（通常是 `billing.viewer`）

## 安装与登录

```bash
magpie plugin add /home/yaka/Documents/google_vertex_plugin
```

然后在 Providers 页面找到 **GCP AI** 点登录，或者：

```bash
magpie plugin login gcp-ai
```

会打开一个 Chrome 窗口，用你的 Google 账号登录即可：

- **第一次登录**直接用 Chrome 当前已登录的账号；电脑上还没有 ADC 时，插件会在这个窗口里顺带完成 gcloud 的 ADC 授权，不用登录两次。
- **再加一个账号**时再点一次登录，插件会打开 Google 的「添加其他账号」页面。登录进来的账号与已有的不同才会新增；还是原来那个则不新增，直接提示已经登录过。
- 每个账号有独立的 ADC 目录（`~/.config/gcp-adc-<账号>`），互不覆盖；第一个账号如果已在默认目录 `~/.config/gcloud` 里，就继续用那一份。
- 登录完成后窗口自动关闭，Cookie 保存在 Chrome 配置目录里（默认 `~/.config/gcp-auto-profile`），读取赠金时复用。
- 授权码和令牌都由 gcloud 自己处理，插件不接触 refresh token 或 client secret。

## 用起来

- **模型**：只显示项目能调用的模型。下拉里没有的，通常是项目没开 Vertex AI，或该模型在对应区域不可用。
- **额度**：例如 `$309.98 remaining / $310.00 USD`，以及最近一笔到期时间。
- **项目**：默认取登录时 Cloud Console 当前打开的项目，模型和赠金不会跑到两个项目上。

## 常见问题

**赠金显示不出来？** 多半是 Chrome 里的登录过期了，重新登录一次即可。

**想换项目或区域？** 项目默认从 Console 读取，也可以用环境变量指定：

```bash
export GOOGLE_VERTEX_PROJECT=your-project-id
export GOOGLE_VERTEX_LOCATION=global
```

**授权页上账号不对？** 同意页可能默认选中 Chrome 里的另一个账号。插件会核对授权后的账号，不一致就什么都不保存，并删掉这次刚写的 ADC 目录；重新登录、在同意页上选对账号即可。

**余额和账单页对不上？** 赠金是结算账号级别的，可能被多个项目共享，控制台本身也有结算延迟。

**为什么设置里没有项目/区域输入框？** 插件形式的 Provider 不能自定义表单字段，这两项自动推导（或用上面的环境变量覆盖）。

## 可配置项

| 环境变量 | 含义 / 默认值 |
| --- | --- |
| `GOOGLE_VERTEX_PROJECT` | 项目 ID，默认从 Console 读取 |
| `GOOGLE_VERTEX_LOCATION` | 区域，默认 `global` |
| `VERTEX_BILLING_ACCOUNT` | 账单账号 ID，默认按项目自动查找 |
| `VERTEX_CHROME_PROFILE` | Chrome 配置目录，默认 `~/.config/gcp-auto-profile` |
| `VERTEX_CHROME_PATH` | Chrome / Chromium 可执行文件路径 |
| `VERTEX_GCLOUD_ACCOUNT` | 指定使用的 Google 账号 |
| `VERTEX_GCLOUD_AUTH_MODE` | `auto`（默认）、`adc` 或 `gcloud` |
| `CLOUDSDK_CONFIG` | gcloud 配置目录，默认 `~/.config/gcloud`；多账号时按账号自动分配 |

## 隐私

插件只做这些事：用你的凭证向 Google 请求模型列表和免费计数、向 Vertex 端点发送推理请求、用本机 Chrome 打开 Cloud Console 读取赠金页面。没有第三方服务器，不上传凭证，不会把网页 Cookie 转成令牌。
