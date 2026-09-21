import { isLiteMode } from "../adapters";
import { liteGetTraceById } from "./lite-trace-queries";
import { getTraceByIdFromTracesTable } from "./traces";

/** 公开详情读取在 SQL 投影阶段排除正文，不能在解码后再删除。 */
export function getTraceById(props: Parameters<typeof getTraceByIdFromTracesTable>[0]) {
  return isLiteMode()
    ? liteGetTraceById(
        props.projectId,
        props.traceId,
        props.excludeInputOutput,
        props.excludeMetadata,
      )
    : getTraceByIdFromTracesTable(props);
}
