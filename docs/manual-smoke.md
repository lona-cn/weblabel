# T15 人工标注闭环验收

读者：人工验收者。读后行动：用可重复的合成图片完成导入、编辑、保存、刷新、导出及键盘检查。验证边界：下面是实际界面验收步骤，不是通过声明；本轮输入生成的成功不证明 GPU、人工编辑、审核或模型通过。全程不启用 Host、不下载权重、不使用账号凭证或用户业务图。

## 前提与本轮目录

按[构建与启动](getting-started.md#构建与启动)选择固定 Node 24.16.0，安装项目依赖并正常启动 core；用网页完成首次设置和密码登录。人工编辑不依赖 Python；最后的独立 COCO checker 才需要 Python。需要真实 WebGPU hardware adapter，没有该条件时只验证诊断/只读并记录未验证，不以软件 adapter 替代。

为每次验收选唯一 run-id。以下示例目录首次必须不存在，再次验收换新 run-id；输入、下载、截图和 API JSON 都放同轮项目内目录，不覆盖历史报告、用户数据或原夹具。先从当前测试子进程移除 `WEBLABEL_RUNTIME_CONFIG`、`WEBLABEL_RUNTIME_ALLOWED_ENV`，不读取或打印原值；禁止隐式继承真实凭证或模型配置。

## 生成确定输入

在项目根的 PowerShell 执行下面完整代码。它只新建输出目录，20 PNG 不预装标注；EXIF 优先复制仓库现存夹具，仅缺失时在本轮目录生成公开四象限 JPEG。不要运行会覆盖整组原夹具的 pnpm media:fixtures。

```powershell
@'
import sharp from 'sharp';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
const root = await realpath(resolve('.'));
if (!process.argv[2]) throw new Error('需要项目内新输出目录');
const output = resolve(process.argv[2]);
const allowed = resolve(root, 'target/documentation-smoke');
const rel = relative(allowed, output);
if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('输出必须在 target/documentation-smoke/<run-id>/images');
async function requirePhysicalInside(candidate) {
  const physical = await realpath(candidate);
  const within = relative(root, physical);
  if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within) || relative(candidate, physical)) {
    throw new Error('输出祖先/目录存在物理路径重定向；不创建或写入图片');
  }
}
let ancestor = resolve(output, '..');
for (;;) {
  try { await requirePhysicalInside(ancestor); break; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = resolve(ancestor, '..');
    if (parent === ancestor) throw error;
    ancestor = parent;
  }
}
await mkdir(resolve(output, '..'), { recursive: true });
await requirePhysicalInside(resolve(output, '..'));
await mkdir(output); // 已存在即失败；不得复用或覆盖
await requirePhysicalInside(output);
for (let i = 0; i < 20; i += 1) {
  const box = [24 + (i % 5) * 31, 20 + Math.floor(i / 5) * 39, 54 + (i % 5) * 31, 72 + Math.floor(i / 5) * 39];
  const pixels = Buffer.alloc(320 * 240 * 3);
  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 320; x += 1) {
      const inside = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
      const checker = ((x >> 4) + (y >> 4) + i) % 2 === 0;
      pixels.set(inside ? [240, 48 + (i * 7) % 160, 28] : checker ? [224, 232, 236] : [36, 44, 52], (y * 320 + x) * 3);
    }
  }
  const png = await sharp(pixels, { raw: { width: 320, height: 240, channels: 3 } }).png().toBuffer();
  await writeFile(resolve(output, 't15-demo-' + String(i + 1).padStart(2, '0') + '.png'), png, { flag: 'wx' });
}
const exif = [];
for (const orientation of [6, 2]) {
  const name = 'orientation-' + orientation + '.jpg';
  let bytes;
  let source = 'repository_fixture';
  try { bytes = await readFile(resolve(root, 'tests/fixtures/media', name)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = 'generated_public_quadrants';
    const pixels = Buffer.alloc(48 * 32 * 3);
    const quadrants = [[235, 30, 30], [30, 210, 40], [25, 60, 235], [235, 210, 20]];
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        pixels.set(quadrants[(y >= 16 ? 2 : 0) + (x >= 24 ? 1 : 0)], (y * 48 + x) * 3);
      }
    }
    bytes = await sharp(pixels, { raw: { width: 48, height: 32, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation }).toBuffer();
  }
  await writeFile(resolve(output, name), bytes, { flag: 'wx' });
  exif.push({ name, source });
}
console.log(JSON.stringify({ output, png_count: 20, exif }));
'@ | node --input-type=module - target/documentation-smoke/2026-10-12T12-52-37-812Z/images
if ($LASTEXITCODE -ne 0) { throw '合成输入失败；保留目录并换新 run-id，不覆盖重跑' }
```

PNG 算法冻结为 16px 棋盘：checker=((x>>4)+(y>>4)+i)%2==0；矩形 RGB=(240,48+(i*7)%160,28)，棋盘两色 (224,232,236)/(36,44,52)。与自动化夹具的 generatedImage/BOXES 相同。EXIF 缺失分支采用 48×32 四象限、quality100、4:4:4，orientation=6/2。

| 文件 | canonical 框 xyxy | EXIF | canonical 尺寸 |
|---|---|---|---|
| t15-demo-01.png 至 t15-demo-20.png | i=0..19：[24+(i%5)*31,20+floor(i/5)*39,54+(i%5)*31,72+floor(i/5)*39] | 无方向变换 | 320×240 |
| orientation-6.jpg | [4,5,20,30] | 6（顺时针旋转） | 32×48 |
| orientation-2.jpg | [6,4,30,25] | 2（水平镜像） | 48×32 |

首框 [24,20,54,72]，末框 [148,137,178,189]。EXIF canonical 四象限：6 的左上/右上/左下/右下依次是蓝/红/黄/绿；2 依次是绿/红/黄/蓝。JPEG 有损不能要求每个解码值等于输入 RGB；比较已知变换后的像素与 canonical 接口结果。

## 创建项目与导入

1. 网页创建项目 T15 manual smoke；新建 Person 类别，发布规范。添加 helmet_state 枚举 wearing/not_wearing/unknown，默认 unknown。
2. 从已发布规范的普通 API/网页规范信息读取并记录真实稳定 label_id、ontology_version_id、project_id。网页不提供自填 label ID；label_person 仅是自动化固定夹具 ID，不能当网页生成值。
3. 用可见 media-import 文件输入选择本轮全部 20 PNG。等待处理完成，普通项目资产列表必须有 20 个 canonical image revisions，再导入本轮两张 EXIF JPEG；记录每张 asset_revision_id，不把已排队视作导入完成。
4. 核对 GPU 诊断 actual_backend=webgpu、device_state=ready 与 hardware adapter。unsupported/lost 时先保全草稿，转[故障指南](troubleshooting.md#gpu)，不继续宣称人工编辑通过。

## 编辑、保存、刷新与单图导出

1. 打开 t15-demo-01.png，矩形工具画彩色区域，选择 Person。完整几何表单输入 canonical 像素 x=24、y=20、w=30、h=52，点击“应用完整几何”，得到 xyxy=[24,20,54,72]；设 helmet_state=wearing，正图明确标记 complete。等待“已同步到服务器”，不能以“已保存到本地”代替。
2. 刷新前普通 GET /api/assets/{asset_revision_id}/annotation?ontology_version_id={ontology_version_id}；记录不可变 revision ID、content hash、completion、真实 label ID、attributes、完整连续像素 bbox_xyxy。刷新后再次 GET 逐字段核对 revision/document 完全一致，画布也显示同一框。
3. 在“单图版本导出”选择这个已保存 revision 和 COCO，按 loss report 显式确认损失。下载实际为 application/json/.json，保存到本轮 downloads；不解压。仅该一图一对象 JSON 可用独立 checker：

```powershell
$labelId = Read-Host '粘贴已发布 Person 的实际 label_id'
$downloadedJson = Read-Host '粘贴本轮单图 COCO .json 路径（项目内）'
python scripts/check-dataset-loader.py $downloadedJson --label $labelId --xyxy 24 20 54 72
if ($LASTEXITCODE -ne 0) { throw 'COCO 类别/连续像素坐标回读失败' }
```

checker 要求一图一对象，独立解析 COCO xywh=[24,20,30,52] 并精确回得 xyxy=[24,20,54,72]；不把 ZIP 或多对象输入交给它。

4. 打开另一张新图，选择 confirmed_negative，独立确认；同步、刷新后普通 GET 核对 completion=confirmed_negative、objects=[]。
5. 对 EXIF6/2，核对 canonical 接口解码尺寸/四象限与画布方向。分别画表中 canonical 框，用几何表单固定：EXIF6 输入 x=4、y=5、w=16、h=25；EXIF2 输入 x=6、y=4、w=24、h=21。保存/刷新/单图 COCO 下载后分别用 --xyxy 4 5 20 30 和 --xyxy 6 4 30 25 运行 checker；每次只保留一个对象。持久几何不含 EXIF 变换或 DPR 因子。

## 键盘、IME 与只读屏障

在另一张本轮测试图画三个框，记录 ID/顺序/canonical 数字。选中中间对象并聚焦对象列表，用真实 Delete 删除；同步后 API/IDB 完整文档只剩首尾对象且顺序不变。普通撤销恢复、重做再次删除，每次推进一个本地 generation，数值不变。

逐项用正式界面和真实键盘执行，不用 Native dispatch、独立 harness 或页面 mock 替代：

- 聚焦文本输入，包括中文 IME composition，按 Delete 只编辑文本、不改标注；结束 composition 后继续核对。
- 原生按钮 Space 正常激活；画布 Space 临时平移，松开后工具恢复，不修改框坐标。
- 包含锁定对象的批量修改/删除整批拒绝，不部分成功。
- 切图后旧选择不能删除新资产；只读服务端 preview 与审核提交锁内快捷键不能产生隐藏修改。

## 固定审核与数据集 ZIP（独立验收）

单图保存不等于审核批准。需要数据集验收时按[团队管理员操作](operations.md#配置团队审核账号与成员)创建独立 reviewer；由标注者领取同一固定任务，同步后提交明确 revision，reviewer 网页查看差异并批准，禁止自审。只选一张 complete、一个对象、已批准 revision，split=train，冻结快照，分别下载 native/COCO/YOLO 数据集 ZIP，明确确认有损格式。

数据集 COCO 是 ZIP，内容 coco/train.json 和图片；与单图 JSON 不同。独立 ZIP 回读按[数据集契约](contracts.md)核对 manifest 的 dataset_version_id、snapshot_manifest_sha256、审核人/理由、固定 revision/content hash 和 split，再分别核对 Native document、COCO xywh、YOLO 归一化数字及媒体 hash。snapshot_manifest_sha256 不是 ZIP manifest.json 字节 hash。上述单图 checker 不适用于此 ZIP；本轮具体 ZIP 检查命令/断言由真实报告保存，未执行不得写通过。

## 失败恢复与报告

任何保存未知/冲突先下载完整本地草稿；保留原 operation/body/base/lease/journal，再按[保存与恢复](troubleshooting.md#保存与恢复)处理，不能直接刷新或清站点数据。输入生成中途失败保留目录，下一次用新 run-id；不覆盖重跑。

报告保存输入/导出字节 hash、精确坐标断言、普通 API 结果、真实截图/trace、adapter 身份、命令/exit 和测试数量或 null；未运行项目单列。截图清空启动码/密码；不保存 Cookie、CSRF 或私人配置。浏览器草稿未同步时服务器备份不包含它。仅本轮合成材料可进入报告，不复用旧通过记录。
