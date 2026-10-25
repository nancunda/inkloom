-- 修复 DraftSegment 的唯一约束（Ruling 39）。
--
-- 原约束 @@unique([projectId, segId]) 把「segId 全书唯一」误解成「segId 只能有一条记录」。
-- 但 segId 唯一指的是 ID 永不复用——编辑产生 v2 时，同一段会同时出现在
-- s1.v1.md 和 s1.v2.md 两个文件里，索引必然有两条记录。
--
-- 正确约束：同一文件内 segId 唯一（结构上不可能重复）。

DROP INDEX "DraftSegment_projectId_segId_key";

CREATE UNIQUE INDEX "DraftSegment_projectId_filePath_segId_key" ON "DraftSegment"("projectId", "filePath", "segId");
