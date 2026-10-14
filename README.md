# WebLabel

WebLabel 是一个在本机运行的图片标注工具。你可以在浏览器里给对象画框、填写类别和属性，审核标注后导出数据集。支持 PNG/JPEG 图片，以及 YOLO、COCO 和原生标注格式。

如果你想先试试人工标注，可以直接用下面的预发布包，不需要配置 AI。AI 是可选的辅助功能：它给出候选结果，由你决定是否采纳。预发布版供试用，真实模型和目标硬件的完整验证仍未完成。

**公开来源说明：** 原始验收证据留在本地私有归档；公开历史保留源码、必要夹具及本页合成截图。历史状态与原始 SHA 不代表在当前公开提交重新验收，详见[公开来源记录](reports/publication/provenance.json)与[报告索引](reports/index.md)。

## 标注界面

左侧选择图片，中间画框，右侧修改对象的类别和属性。

![标注界面：选中的检测框、类别与属性面板，以及“已同步到服务器”状态](docs/images/readme/editor-rc3.png)

<details>
<summary>查看类别和属性设置</summary>

![类别和属性设置：名称、颜色、快捷键、属性选项与标注指南](docs/images/readme/02-project-ontology.png)

</details>

工作台截图使用 v0.1.0-rc.3 和合成示例图；类别设置截图来自早期版本。

## 先试用

### 下载并启动

预发布包适用于 Windows 和 Linux 的 x64 电脑。画框编辑还需要支持 WebGPU 的桌面浏览器和显卡，建议先用桌面 Chrome 或 Edge。

1. 到 [v0.1.0-rc.3 下载页](https://github.com/lona-cn/weblabel/releases/tag/v0.1.0-rc.3)，Windows 选择以 `win32-x64.tar.gz` 结尾的包，Linux 选择以 `linux-x64.tar.gz` 结尾的包，同时下载对应的 `.sha256` 校验文件。
2. 按[下载与校验说明](docs/getting-started.md#下载预发布包)核对 SHA256，完整解压，再在解压目录打开终端。
3. 执行下面对应的启动命令。终端需要一直开着；用完按 Ctrl+C 停止服务。

Windows（PowerShell）：

```powershell
.\launch.cmd
```

Linux：

```sh
sh ./launch.sh
```

包里已经带了 Node 和应用程序，人工标注不需要另装 pnpm、Rust、Python 或模型工具。它不是签名安装器；Linux 仍需要兼容的系统库，运行与维护说明见包内的 `BUNDLE.md`。

启动后打开终端显示的 `WEBLABEL_LOCAL_URL`，默认是 `http://127.0.0.1:48100`。如果没有可用的 WebGPU，只能查看或诊断，不能画框。

按上面的方式启动时，数据保存在解压目录下的 `data` 中。后续启动请继续使用同一数据目录，升级前先[备份](docs/backup-restore.md)，不要把数据随旧程序包一起删掉。

### 标注第一张图

1. 首次启动时，把终端中的 `WEBLABEL_BOOTSTRAP_CODE` 填入网页，设置并确认密码。默认管理员是 `local-admin`；启动码十分钟内有效，只能用一次，不要分享或截图。
2. 新建项目，设置类别和属性，上传一张 PNG/JPEG 图片，等待处理完成。
3. 打开图片，在“固定标注规范”中选择刚创建的规范。再从“绘制类别”选择类别，点击“画框”并拖出矩形，在右侧填写属性。确认状态显示“已同步到服务器”后，这次修改才算保存到服务端。

已有账号时直接用用户名和密码登录。已有服务时直接打开它的网页地址，不必再启动一份。后续的审核、导入已有标注和导出步骤见[入门指南](docs/getting-started.md)。

<details>
<summary>从源码构建</summary>

先按[开发环境说明](docs/getting-started.md#开发者从源码准备本地服务)准备固定版本的工具，再在仓库根目录逐条执行；任一步失败都先处理错误，不要继续启动：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
pnpm start:local
```

默认构建目录是 `target/local-release`。重复构建不会覆盖旧目录；需要重新构建时，按[构建与启动](docs/getting-started.md#构建与启动)选择新目录。`doctor` 检查工具和发行文件，不代表浏览器 GPU 或 AI 模型已可用。

</details>

## 使用前注意

- **只在本机使用。** 默认服务只供本机访问，不支持局域网或公网部署。当前只做图片的矩形框和属性标注，不支持分割、视频或云端部署。
- **留意保存状态。** “本地待同步”不等于服务端已保存。遇到冲突或保存失败，先保全草稿，再按[故障指南](docs/troubleshooting.md)处理。
- **空标注不等于负样本。** 一张没有框的图片，需要明确确认没有目标，不能仅凭空标注把它当作负样本。
- **审核需要独立账号。** 项目默认不能审核自己提交的标注，需要另一个有审核权限的账号。审核只对当时提交的版本有效，后续修改需要重新提交；单账号仍可编辑和保存。
- **导出前检查格式差异。** 先确定要导出的图片和标注版本，生成固定快照；如果目标格式会丢失属性等信息，应用会要求你确认。
- **AI 不替你做决定。** 候选结果需要明确采纳，也可以撤销。图片发给外部模型前，必须满足项目设置和服务端权限要求，并获得你的授权。哪些模型还没有完成验证，见[已知限制](docs/known-limitations.md#模型事实矩阵)。

仓库目前为 **UNLICENSED**，没有授予再分发或商业使用许可。

## 继续阅读

- [入门指南](docs/getting-started.md)：登录、导入、标注、审核和导出。
- [支持范围](docs/current-capabilities.md) · [已知限制](docs/known-limitations.md) · [故障指南](docs/troubleshooting.md)。
- [运维手册](docs/operations.md) · [备份与恢复](docs/backup-restore.md)。
- [开发指南](docs/development.md) · [继续开发](START_HERE.md)。
- [验证说明](docs/verification.md) · [验证记录](reports/index.md)。

完整目录见[项目文档](docs/README.md)。
