# diagnose-llm-transport-failure

[English](README.md) | **中文**

一个 [DSH](https://platform.deepseek.com) 技能，专门对付这句话：

```
DeepSeek Messages transport failed
```

这句话本身不含任何原因。在桌面机上，它最常见的原因是**本机安全软件或企业代理在解密 HTTPS**：它们把连接换成自己的根证书签名，浏览器信任（因为装进了系统证书库），Node/Electron 不信任（因为它只认自己打包的根证书）。于是浏览器能正常打开网页、模型请求却在握手阶段就挂；每次重试都重新握手，经常正好碰上没被拦的连接，看起来就成了“偶发网络抖动、重试一下又好了”。

这个技能把“猜”换成 30 秒内能出结论的探测：解析域名、发起真实握手、读出对方出示的证书链、判断每一条连接能否验证通过，并按故障类别给出对应的修法。

## 它做什么

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 技能主流程：探测 → 归类 → 修复 → 验证，附一份“别急着下这些结论”的清单 |
| `reference.md` | 按需加载：cause 在代码里哪一层被丢掉、重试延迟怎么算、日志与会话位置、Node 与 Chromium 的信任差异、两种修复配方 |
| `scripts/tls-probe.mjs` | 探针。零依赖、不写文件、不使用任何凭据 |
| `scripts/find-transport-failures.mjs` | 汇总 DSH Desktop 主机日志：一天一个文件、计数 + 最近几条 |

探测结果长这样：

```
host: api.deepseek.com
addresses: 60.204.2.5, 60.204.2.4
NODE_EXTRA_CA_CERTS: (not set)

60.204.2.5 #1  NOT VERIFIED  issuer=Kaspersky Anti-Virus Personal Root Certificate  TLSv1.3  SELF_SIGNED_CERT_IN_CHAIN  [interception]
60.204.2.5 #2  VERIFIED      issuer=GeoTrust TLS RSA CA G1  TLSv1.3
...
VERDICT: a Node/Electron fetch on this host throws for these connections.
CAUSE: TLS is being decrypted locally by security software or a proxy (...).
FIX:   exclude this host from that product's encrypted-connection scanning, ...
```

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 全部握手验证通过 —— 证书不是这次失败的原因 |
| `1` | 至少有一条验证失败 —— 这正是 `fetch` 会抛错的情况 |
| `2` | 完全连不上或域名解析不了 —— 属于连通性问题，不是信任问题 |

探针只对 443 端口带 SNI 握手、不发送业务数据、不使用凭据。它也会报告“被解密但验证通过”的情况——因为能握手成功就说明证书不是问题所在。

## 安装

技能从 `~/.dsh/skills/<名字>/SKILL.md` 发现，所以直接克隆到那个路径：

```powershell
# Windows
git clone https://github.com/spick233/dsh-skill-diagnose-llm-transport-failure "$env:USERPROFILE\.dsh\skills\diagnose-llm-transport-failure"
```

```bash
# macOS / Linux
git clone https://github.com/spick233/dsh-skill-diagnose-llm-transport-failure ~/.dsh/skills/diagnose-llm-transport-failure
```

开一个新会话（或重启应用）后，它就会出现在技能列表里，遇到传输类报错自动触发。

## 用法

让智能体排查报错，技能会自己加载。也可以直接手工跑：

```bash
node scripts/tls-probe.mjs api.deepseek.com 5
```

第二个参数是每个解析地址的握手轮数：平时 `5`，故障是偶发时用 `8`——因为中间人并不一定拦每一条连接。

想先确认失败确实存在，再汇总日志：

```bash
node scripts/find-transport-failures.mjs
```

## 覆盖的故障类型

- 安全软件 / 企业代理的 TLS 中间人（最常见）
- 证书链本身有问题：系统时间错乱、缺中间证书、CA 库过期
- DNS 失败（`ENOTFOUND`）
- 出口被封、必须走代理、服务商真的故障
- “全部验证通过但应用还是失败” —— 技能会转到失败码本身和 `reference.md` 继续查

在 Windows 11 + DSH Desktop 2.0.17 / Electron 44 上实测。脚本是纯 Node（20+），跨平台可用；日志汇总脚本内置了 Windows、macOS、Linux 三种桌面版日志路径。

## 为什么不能只改报错文案

因为 cause 是被**契约**丢掉的，不是某一行日志写漏了：适配器把底层异常挂在 `cause` 上，`LlmError` 的可序列化快照只保留 `{message, code}`，归一化又原样返回这个快照——于是 UI、重试事件、保存下来的会话里全是同一句没有信息的话。`reference.md` 里给了确切位置、一段恢复 cause 的本地补丁，以及值得提给上游的结构性修法。

## 实测案例

某台 Windows 机器上 15 次请求有 2 次在 183 ms / 194 ms 内失败，日志只有一句 `[TRANSPORT]: DeepSeek Messages transport failed`；连续 6 次重试全部同样报错，整轮对话失败。同机浏览器打开同一个 API 完全正常。

探针显示证书被卡巴斯基替换：6 次握手里 4 次拿到 `Kaspersky Anti-Virus Personal Root Certificate`，那次“正常”的请求只是恰好落在没被拦的连接上。在卡巴斯基的「加密连接扫描 → 管理排除项」里加上该域名后，10/10 握手拿到真实证书、15/15 请求正常——整个过程不需要关闭杀毒软件，也没有降低任何校验。

## License

[MIT](LICENSE)
