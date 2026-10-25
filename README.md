# agent-purge

一份系统提示词，喂给多个 coding agent。支持替换（replace）、追加（append）、清空（off）三种模式，可热切换，全程可逆。

```
agent-purge web          # 本地控制台 http://127.0.0.1:7788
agent-purge codex        # 用当前 persona 启动 codex
agent-purge pi --ask "…" # 一次性提问
```

## 它做什么

每家 coding agent 读系统提示词的位置都不一样：有的认启动参数，有的认配置文件，有的只能靠插件改运行时对象。agent-purge 把这些入口统一成三件事：

| 通道 | 机制 | 生效范围 |
|---|---|---|
| `install` | 写入该 harness 的托管配置块（Markdown / hooks / 插件） | 常驻，别人启动也生效 |
| `shim` | 往 PATH 前置同名小壳，转发给 `agent-purge <h>` | 裸敲命令也接管 |
| `slash` | 会话内 `/purge on\|off\|status` | 热切换，不动磁盘 |

三层都写的是同一份 `personas/<id>.md` 的正文。`--mode off` 或 Web 总开关关掉时，全部撤回到原样——不留残渣。

## 安装

```bash
npm i -g agent-purge     # 或 npx agent-purge web
```

要求 Node ≥ 20，零依赖。

**数据独立存放**，升级不会被覆盖：默认 `~/.agent-purge/`（Windows `C:\Users\<你>\.agent-purge\`），里面是 `state.json` 和 `personas/`。想换位置就设环境变量：

```bash
export AGENT_PURGE_HOME=/path/to/your/data     # Windows: setx AGENT_PURGE_HOME D:\ap-data
```

旧版本（0.1.x）把数据放在包目录里，首次运行会自动搬到新家，原文件不动。

## 人设

`personas/<id>.md` = frontmatter（`id` / `name` / `description` / `harness` / `model`）+ 正文。正文就是会被写进系统提示词的那一段。

```bash
agent-purge ls                 # 列出全部 persona，标出当前匹配的
agent-purge use <id>           # 切换当前 persona
agent-purge pi --persona <id>  # 只这一轮用别的
```

首次运行会在 `personas/` 下生成 `neutral.md` 起步模板。

## 支持情况

`agent-purge ls` 和 Web 控制台显示的是**运行期真值**：每个 harness 有没有装、版本、注入层（SYS / USER）、三个通道各自可用性。`matrix.json` 里是静态能力表，两者冲突时以运行期为准。

闭源桌面端（提示词在服务端或二进制里）只做原样启动，不做任何注入——`agent-purge <h>` 会明确打印原因，不会假装生效。

## 目录

```
bin/         CLI 入口
lib/         状态、persona、注入、通道、检测
backends/    每个 harness 的启动参数与身份句处理
web/         控制台（server.mjs + ui.html）
bench/       注入成功率实测与裁判脚本（开发用，不参与运行）
matrix.json  能力矩阵
```

## 边界

- 只改提示词相关的位置，不碰二进制、不破解、不绕过任何授权。
- 所有改动可逆：`agent-purge uninstall <h>` / `disarm` / `--mode off`。
- 状态只存本机 `state.json`，不上传任何数据。

## License

MIT

---

感谢 [LINUX DO](https://linux.do) 社区
