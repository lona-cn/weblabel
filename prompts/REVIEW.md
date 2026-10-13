# 独立审查请求

只读检查指定task的实际diff、任务卡和关联契约。不能运行shell或写文件。主Agent应提供base/target commit或patch位置、命令日志及上游证据。

## 先查规格

逐条核对验收行为是否有代码和真实测试支撑。重点查是否偷换范围、漏实现、用mock冒充live、用软件GPU冒充硬件，或手改生成类型。

## 再查质量与安全

检查输入边界、坐标/EXIF、pointer与IME。核对异步ACK和AI过期结果处理，以及transaction/CAS/idempotency、lease和role权限。

继续检查外发scope、官方runtime权限、秘密泄漏、资源回收、错误恢复及数据集快照。不能仅凭lint通过判断产品正确。

## 返回结论

返回 verdict=pass/rework/blocked、blocking_issues[{path,line,requirement,evidence,minimal_fix}]、nonblocking_notes、unverified_claims。

日志缺失的结论写入未验证项，不能推定测试通过。需要复现时提出最小步骤，由主Agent执行。
