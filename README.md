# saunagent

一个个人工作 room：左侧是任务 agent，右侧是统一对话。用户直接向 room 发消息，主管选择已有任务或创建新任务，保持用户原文不变。基于 **Pi coding agent 1.4.0**、React 和 Ink，首版采用本地命令行 TUI。

## 启动

需要 **Node.js ≥22.19**，推荐 Node 24。Node 20 不支持本项目使用的内置 SQLite。

```sh
cd /home/teng.wang/Code/saunagent
npm install
npm start -- --demo
```

`npm start` 会先构建当前源码，再打开 TUI，不依赖上次生成的 `dist/`。

## 在 saunagent 中开发自身

在这个项目目录启动后，直接说“查看当前目录”或“修复这个项目的某个问题”即可。启动目录会自动作为可用工作目录传给主管，不需要先手动注册。输入 `/project` 可查看目录；直接发送一个目录路径也会作为对话内容处理。

修改、测试完成后，在 room 输入 `/reload`。启动进程会暂停任务，等待当前工具结束，保存消息和执行记录，再将源码构建到独立临时目录。构建成功后关闭旧界面，启动新代码，同时重新读取 `models.json`、`auth.json` 和配置。重开后任务保持暂停，使用 `/resume` 继续，或发送新的任务指令。

构建失败时旧界面继续可用，并显示编译错误；新版本启动失败时回到上一版本。首次从旧版升级到这个启动方式，需正常退出旧 TUI 并执行一次 `npm start`。`scripts/start.mjs` 是常驻启动器，修改启动器本身后需要退出并重新启动；普通 `src/` 修改使用 `/reload` 即可。

界面内置标签、状态、命令帮助及系统提示统一使用英文；用户消息、任务名称、agent 回复和历史内容保留原文，不做翻译。

正常 room 显示发送者、任务名和引用内容，隐藏内部消息/任务 ID。`Ctrl+G` 可临时显示 ID，任务详情中仍保留标识，供高级命令使用。主管提出澄清时直接自然语言回答，原请求与补充会一起交给同一任务。

`--demo` 使用 Pi 自带的模拟 provider，实际经过 coding-agent 会话，但不会调用真实模型或执行编码工具。用于体验界面、路由、任务队列和恢复，不代表模型能力验证。演示路由是简单的确定性规则：输入包含“另外”“新任务”“独立”等词时创建新任务，指代不明时请求指定。

真实模型模式：通过环境变量提供所选 Pi provider 的凭证，配置 `.saunagent/config.json` 后运行：

```sh
npm start
```

支持 Pi 的内置 provider 和自定义兼容接口。凭证可放在独立的 `auth.json`，或通过环境变量提供；密钥不写入 room 或 `config.json`。调用真实模型会产生相应服务的费用；演示测试不使用真实 API。

### Pi 风格的 models.json 和 auth.json（推荐）

默认在状态目录中读取两个文件，配置解析和凭证存储直接复用固定版本的 Pi `ModelRuntime`：

`<state-dir>/models.json`：

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://llm2.jiwi.org/coder/v1",
      "api": "openai-completions",
      "models": [
        { "id": "gpt-6.1-sol", "maxTokens": 8192 }
      ]
    }
  }
}
```

`<state-dir>/auth.json`：

```json
{
  "openai": {
    "type": "api_key",
    "key": "你的网关密钥"
  }
}
```

`config.json` 只需保留模型选择、项目和调度设置：

```json
{
  "model": { "provider": "openai", "modelId": "gpt-6.1-sol" },
  "supervisorModel": { "provider": "openai", "modelId": "gpt-6.1-sol" }
}
```

填好以后直接 `npm start`，无需导出密钥变量。`auth.json`、`models.json` 和 `config.json` 模型选择中的 provider ID 必须对应：例如自定义名称为 `grp_openai` 时，主管和默认模型也要选择 `grp_openai/gpt-6.1-sol`。仍选择 `openai` 会走内置 provider，而不是自动寻找名字相近的网关。新建凭证文件使用 `0600` 权限，文件已加入 `.gitignore`；不改写已有密钥，也不把已解析的值复制到其他配置中。空的 `key` 会继续允许环境凭证兜底。

在 TUI 中输入 `/model` 或 `/models`，可查看实际生效的默认模型、主管模型、API 协议及地址；带参数时继续用于切换。模型调用失败会显示保存的底层错误原因，已知密钥会从界面诊断中遮蔽。

也可以直接复用现有 Pi 文件：

```sh
npm start -- --models ~/.pi/agent/models.json --auth ~/.pi/agent/auth.json
```

支持 Pi 原生的模型元数据和认证解析，包括 API-key/OAuth 凭证格式；saunagent 当前没有 `/login` 界面。显式文件参数必须指向现有文件。`models.json` 中明确列出的 provider 优先于旧版 `config.json.providers` 和 `OPENAI_BASE_URL`；未列出的 provider 仍可使用旧版配置。`PROVIDER`、`MODEL`、`SUPERVISOR_PROVIDER`、`SUPERVISOR_MODEL` 仍然可以覆盖模型选择。

模型文件修改后重新启动生效。启动只离线加载配置，不刷新远端模型目录；任务恢复仍需手动继续。高级的 Pi 密钥命令、环境插值等语义由 Pi 官方模块处理，使用共享文件时应了解其中的配置。

### 自定义 LLM API URL

兼容 Chat Completions 的网关可直接使用环境变量：

```sh
export PROVIDER=openai
export OPENAI_BASE_URL=https://你的网关/coder/v1
export MODEL=服务端接受的模型ID
export OPENAI_API_KEY=你的网关密钥
npm start
```

此时请求发送到 `$OPENAI_BASE_URL/chat/completions`，保留 `/coder/v1` 这类路径前缀。自定义模型 ID 会注册到 Pi，不要求出现在内置模型目录中。`MODEL` 同时作为任务默认模型和主管模型；若要单独设置主管，可再设置 `SUPERVISOR_MODEL`，必要时设置 `SUPERVISOR_PROVIDER`。显式配置过单个任务的模型不受这几个默认值覆盖。

设置 `OPENAI_BASE_URL` 时，接口协议默认是 `openai-completions`；如果网关提供 Responses，设置 `OPENAI_API_TYPE=openai-responses`。不要把 Chat Completions 的服务配置成 Responses。完整 `/chat/completions` 或 `/responses` URL 也可归一化为基础地址，但协议必须与 `OPENAI_API_TYPE` 一致。

没有使用 `models.json` 定义该 provider 时，环境地址覆盖旧版默认地址配置，且不会自动写入文件。修改 URL 或 provider 配置后重新启动；只切换模型时可以在 TUI 使用 `/model`，但启动环境中的 `MODEL` / `SUPERVISOR_MODEL` 仍然优先。

也可以在 `<state-dir>/config.json` 增加命名 provider，设置不同 URL、模型和密钥变量：

```json
{
  "model": { "provider": "gateway", "modelId": "你的模型ID" },
  "supervisorModel": { "provider": "gateway", "modelId": "你的主管模型ID" },
  "providers": {
    "gateway": {
      "baseUrl": "https://你的网关/coder/v1",
      "api": "openai-completions",
      "apiKeyEnv": "GATEWAY_API_KEY",
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  }
}
```

启动前设置 `GATEWAY_API_KEY` 即可，配置文件不保存实际密钥。支持的 `api` 为 `openai-completions`、`openai-responses`、`anthropic-messages`；Messages 使用 SDK 基础地址，例如 `https://你的网关/coder`，由 SDK 追加 `/v1/messages`。上下文和输出上限应按服务端实际限制填写。自定义网关的价格未知，当前不提供可靠的金额估算。

在其他项目目录启动已构建的程序：

```sh
node /home/teng.wang/Code/saunagent/dist/cli.js
```

默认状态保存在启动目录的 `.saunagent/`。需要跨项目共用一个 room 时，始终指定同一个状态目录：

```sh
node /home/teng.wang/Code/saunagent/dist/cli.js --state-dir /绝对路径/room-data
```

## 使用

输入 `/` 或 slash 命令前缀时，在输入区下方显示 Pi 风格的纵向候选列表（命令、说明和选中高亮，最多显示 5 项）。`↑↓` 选择，`Enter` 采用候选但不发送，`Esc` 关闭；按 `Tab` 补全命令；多个候选可连续按 `Tab` 循环，`Shift+Tab` 反向选择。唯一候选补全后自动加空格；补全不发送命令，也不改动已有参数。`Tab` / `Shift+Tab` 仅用于补全，没有候选时不执行操作。按 `Ctrl+T` 在输入区和左侧任务栏之间切换，`↑↓` 选择任务，`Enter` 返回输入；选中任务后发送目标显示为 `@任务名`，右侧立即显示该 agent 的对话流（用户指令、agent 回复和相关系统消息），无需按 `Ctrl+D`。`Esc` 返回全部 room 对话和自动路由。任务 ID 用于命令和手动 `@`，避免任务名含空格或重名造成歧义。

候选列表关闭时，输入区 `↑↓` 回溯已提交的消息和命令；多行输入优先上下移动光标，到首行/末行后进入历史。向下越过最新历史恢复原草稿和光标。历史最多保存 100 条（连续重复去重），保存在状态目录的 `input-history.json`，重载和重启后可用；其中可能包含输入的敏感内容，请按 room 数据同样保护。

`Enter` 发送，`Alt+Enter` 或 `Ctrl+J` 插入换行；支持粘贴多行。`PgUp/PgDn` 滚动当前对话，`Ctrl+D` 可选打开所选任务的元信息、工具和执行记录，`Ctrl+G` 切换内部标识。普通消息及明确 `@` 消息的正文按原样转交；命令前缀属于 UI 控制，不转交给模型。

常用命令：

```text
/project add player /绝对路径/player
/projects
/new 播放器排查 --project player
@任务ID 检查播放器为什么启动失败，先分析日志
/reply 消息ID 按这个方案改
/steer 任务ID 先停修改，优先检查新日志
/route 消息ID 正确任务ID
/resume all
/pause 任务ID
/retry 任务ID
/model supervisor openai/gpt-6-sol
/model 任务ID anthropic/模型ID
/complete 任务ID
/clear 任务ID
/clear all
/memory [任务ID]
/archive 任务ID
/unarchive 任务ID
/help
```

自动新建任务时，主管会根据实际任务目标生成简短名称（使用用户的语言），而不是直接截取开头或使用“新任务”等泛称；澄清后创建的任务仍按原始目标命名。`/new 名称` 手动指定的名称保持不变。任务名称仅用于显示，不改写转交的用户原文。

任务新建或收到新指令后开始执行；默认最多运行 3 个任务，后续消息排队。显式 `/steer` 介入当前工作，普通无目标消息也可由主管识别明确的调整方向要求。指代不清时主管在 room 提问，可以直接回答，主管关联原请求；高级命令 `/route` 仍可手动分配。`/reroute` 默认重试最近未分配的消息，也可带消息 ID。

纠正已经执行的消息时先暂停原任务，再转交原文，保留转交记录；历史执行不会自动撤销。原任务中其他排队消息保留为暂停状态，手动继续前应核对。

## 退出与恢复

`Ctrl+C` 清空当前输入，不退出、不删除历史，也不暂停任务。`Esc` 优先关闭 slash 候选、退出详情或任务选择；在自动路由输入区按 `Esc` 暂停任务（输入草稿保留）。

`/quit` 停止接收新工作，在工具边界阻止新操作，等待当前已开始的工具结束并保存结果，再关闭存储。直接使用 `/quit!` 可以强制中断当前调用（进入正常退出等待后不再接收新命令）；已产生的外部副作用可能需要人工或 agent 核对。

重新打开时所有未完成任务保持暂停，**不会自动开始模型请求或执行工具**。使用 `/resume 任务ID` 或 `/resume all` 继续。已提交输入按投递 ID 继续原来的 JSONL 会话，避免恢复时重复写入用户原文。优雅退出会等当前工具结束；若进程在工具结果写入前崩溃，恢复不会重放该工具。强制退出可能留下未完成的外部操作，需要人工或 agent 核对。

本轮结束显示“Turn finished”；调用 `ask_user` 后显示“Awaiting reply”。只有用户执行 `/complete` 才表示已验收。归档仅影响显示，历史仍然保留。

### 清理暂时不用的 agent

`/clear` 默认作用于当前选中的任务；也可 `/clear 任务ID`（或唯一任务名）。`/clear all` 只处理未收起且可安全清理的空闲任务，跳过运行中、等待用户回复、有排队/失败输入的任务。没有选中任务时，裸 `/clear` 会提示指定目标，不会自动批量清理。

清理会使用任务模型将公开的用户指令、agent 进展与结果连同上次 memory 总结成历史摘要（长历史分块处理，无编码工具），先提交到 `<state-dir>/memory.sqlite`，再收起任务并重置其模型会话。真实模式会产生总结请求费用；demo 只生成确定性摘要。总结失败或为空时不清理。没有新历史时不会重复生成 memory。

`/memory` 查看已存摘要，`/memory 任务ID` 查看指定任务的摘要版本。通过 `@任务ID 新指令` 或选中恢复后的任务发送消息，会携带最近的摘要开启新会话，而不是重新输入全部旧对话。摘要仅为历史参考，不构成新执行授权。清理不等于验收；`/unarchive` 可恢复显示，`/resume all` 不会唤醒已收起的任务。

此处“清理”是收起 agent 并释放其旧模型上下文，不是擦除 room 消息或磁盘历史：公开原文与任务 JSONL 记录仍保留，旧会话文件不会删除。memory 中保留摘要及其对应公开消息快照；其中可能有敏感信息，请按 room 数据同样保护。摘要是有损压缩，必要时仍需核查原始记录。


## 配置与工具

首次启动生成 `<state-dir>/config.json`：

```json
{
  "model": { "provider": "openai", "modelId": "gpt-6-sol" },
  "supervisorModel": { "provider": "openai", "modelId": "gpt-6-sol" },
  "maxTasks": 3,
  "maxSubagents": 4,
  "projects": [
    { "name": "player", "cwd": "/absolute/player", "skills": [] }
  ],
  "instructions": "",
  "skills": []
}
```

关闭 TUI 后可编辑完整配置。支持公共和项目级指令、skills 路径；任务加载工作目录各级 `AGENTS.md`、根 README 和 skills 目录。修改更深层目录前，agent 仍须读取其适用指令。未绑定项目的任务使用启动目录，界面详情会显示这一点；编码任务应先绑定项目。

任务使用 Pi 原生 `read/write/edit/bash` 工具及默认工具策略，没有另加审批层。主管没有编码工具。任务可自行调用内部 `subagent`，内部子任务有独立上下文，继承模型、目录和项目规则，结果只返回父 agent；全局最多同时运行 `maxSubagents` 个。当前内部子任务不递归创建子任务。

## 存储与实现

- `room.json`：公开消息、任务目录、投递队列、路由和纠正记录，采用同步落盘与原子替换。
- `memory.sqlite`：不可变的任务历史摘要版本及对应公开消息快照。
- `sessions/<任务ID>.jsonl`：该任务当前模型会话。Pi coding agent 的 append-only JSONL，不是 SQLite harness。
- `sessions/<任务ID>.<会话ID>.jsonl`：清理后新建的任务会话，旧文件保留。
- `agent/`：本 room 专用的 Pi agent 目录，避免读写用户全局 `~/.pi/agent`。
- `room.lock`：防止同一 room 同时被两个程序写入，异常退出后可识别失效进程锁。

每个任务一个独立 `AgentSession`，暂停其他任务时不会打开它们的会话。room 先保存投递，再把投递 ID 写入会话的 `saunagent.delivery` 自定义记录。未完成的同一投递在恢复时继续该会话，而不是再写一条用户消息。一轮结束时的答案按会话 leaf entry ID 去重。主管路由和历史总结使用一次性内存会话，不落盘；路由结果仍在 `room.json`，摘要仍在 `memory.sqlite`。工具细节在本次运行的任务详情中查看，完整 transcript 在对应 JSONL 中。

和原先的 Pi Durable 相比，有意保留的差异：

- 没有 request ID 重放。崩溃发生在工具尚未写出结果时，恢复不能按 Durable 的方式重放该工具；优雅退出仍会等当前工具结束并保存结果。强制退出可能中断工具。
- 中断在助手消息上的生成，恢复时会从模型上下文里省略这条 aborted 消息，再从其上一条用户或工具结果继续。这不是 Durable 的原提交重接。
- 内部 subagent 是工具调用期间的内存会话，最终文本写入父会话的工具结果。子会话本身不单独保存，中途崩溃不会重放子任务。
- 同一次运行里的 prompt 和 steer 若一起结束，会共用同一个答案 entry ID，room 因此只显示一条答案。
- 自动 compaction 和 cache warming 关闭。`/clear` 仍是历史摘要的入口。升级前留下的 `*.sqlite` harness 文件不再读取。

当前首版对相同工作目录采用**整轮任务串行**，比最终设计的“读取可并行、修改和测试串行”更保守。不同目录并行。目录关系只比较规范化后的相同路径，父子目录、Git worktree 共享资源及外部服务暂未协调；使用者应将共享写入资源绑定到同一个项目目录。

尚待完善：退出后在详情页浏览完整历史工具记录、长期不活跃任务自动收起、更多扩展配置，以及 Unicode 光标和小终端布局。Pi coding agent 依赖固定在 1.4.0。

## 开发与验证

```sh
npm run check
npm test
npm run build
```

测试覆盖原文转交、引用和显式目标、歧义分配、并发与同目录队列、steer、纠正、显式验收、退出恢复，以及 coding-agent JSONL 会话的上下文延续、输入去重和当前工具落盘后暂停。模拟 provider 的测试不代表真实服务、模型质量或全部项目环境已验证。

已确认的产品规则和首版验收流程见 [设计记录](docs/design.md)。
