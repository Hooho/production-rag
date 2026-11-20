import { DetailDialog } from "./DetailDialog";
import { GraphEntityPanel } from "./GraphEntityPanel";

// 实体详情弹窗：检索诊断里点实体名字时打开，内容和图谱里点实体看到的一样。
// 放在别的弹窗里时 DetailDialog 会变成伴随浮窗，贴着点开的那个名字出现。
// 只带文档 id：接口按这份文档的生效图谱读，普通用户只能看自己读得到的文档。
export function GraphEntityDialog({
  entityId,
  documentId,
  onClose,
}: {
  entityId: string;
  documentId?: string | null;
  onClose: () => void;
}) {
  return (
    <DetailDialog
      open
      title="实体详情"
      onClose={onClose}
      className="ag-dialog-entity"
    >
      <GraphEntityPanel
        entityId={entityId}
        documentId={documentId}
        onClose={onClose}
        embedded
        summaryOnly
      />
    </DetailDialog>
  );
}
