import { fromBinary } from "@bufbuild/protobuf";
import { CheckedExprSchema } from "@bufbuild/cel-spec/cel/expr/checked_pb.js";
import type { Expr } from "@bufbuild/cel-spec/cel/expr/syntax_pb.js";

type Value = { expr?: string; literal?: unknown };
type Step = { id: string; op: string; capability?: string; version?: string; when?: string; args?: Record<string, Value>; value?: Value };

// The caller verifies saved identities. Recognize this dataflow without evaluating expressions.
export function taskFollowUpSummary(artifact: unknown) {
  try {
    const program = artifact as { format?: string; entrypoint?: string; steps: Step[]; expressions: Record<string, { checked: string }> };
    if (!["keir-artifact/2", "keir-artifact/3"].includes(program.format ?? "") || program.entrypoint !== "TaskCompleted" || !Array.isArray(program.steps)) return null;
    const calls = program.steps.filter(step => step.op === "CALL");
    const [read, write] = calls;
    if (calls.length !== 2 || read.capability !== "tasks.get" || read.version !== "3" || read.when
      || write.capability !== "tasks.create" || write.version !== "2" || !write.when
      || Object.keys(write.args ?? {}).sort().join() !== "projectId,title") return null;
    const used = new Set<string>();
    function expression(value: Value | undefined, before: number, depth = 0): Expr | undefined {
      if (depth >= 16 || typeof value?.expr !== "string" || Object.hasOwn(value, "literal")) return;
      const encoded = program.expressions[value.expr]?.checked;
      if (typeof encoded !== "string" || encoded.length > 22_000) return;
      const expr = fromBinary(CheckedExprSchema, Uint8Array.from(atob(encoded), char => char.charCodeAt(0))).expr;
      if (expr?.exprKind.case !== "identExpr") return expr;
      const name = expr.exprKind.value.name;
      const index = program.steps.findIndex(step => step.id === name);
      const binding = program.steps[index];
      if (index < 0 || index >= before || binding.op !== "BIND" || binding.when) return expr;
      used.add(binding.id);
      return expression(binding.value, index, depth + 1);
    }
    const field = (expr: Expr | undefined, record: string, name: string) => {
      const node = expr?.exprKind;
      return node?.case === "selectExpr" && !node.value.testOnly && node.value.field === name
        && node.value.operand?.exprKind.case === "identExpr" && node.value.operand.exprKind.value.name === record;
    };
    const string = (expr: Expr | undefined) => expr?.exprKind.case === "constExpr"
      && expr.exprKind.value.constantKind.case === "stringValue" ? expr.exprKind.value.constantKind.value : undefined;
    const readIndex = program.steps.indexOf(read), writeIndex = program.steps.indexOf(write);
    if (readIndex >= writeIndex || !field(expression(read.args?.taskId, readIndex), "input", "taskId")) return null;
    const guardIndex = program.steps.findIndex(step => step.id === write.when);
    const guard = program.steps[guardIndex];
    if (!guard || guardIndex >= writeIndex || guard.op !== "BIND" || guard.when) return null;
    used.add(guard.id);
    const condition = expression(guard.value, guardIndex)?.exprKind;
    if (condition?.case !== "callExpr" || condition.value.target || condition.value.function !== "_==_"
      || condition.value.args.length !== 2 || !field(condition.value.args[0], read.id, "status")
      || string(condition.value.args[1]) !== "COMPLETED") return null;
    if (!field(expression(write.args?.projectId, writeIndex), read.id, "projectId")) return null;
    const title = expression(write.args?.title, writeIndex)?.exprKind;
    if (title?.case !== "callExpr" || title.value.target || title.value.function !== "_+_"
      || title.value.args.length !== 2 || !field(title.value.args[0], read.id, "title")) return null;
    const titleSuffix = string(title.value.args[1]);
    if (titleSuffix === undefined || !program.steps.every(step => step === read || step === write || used.has(step.id))) return null;
    return { titleSuffix, sameProject: true as const, conditions: [{ field: "status" as const, value: "COMPLETED", step: read.id }] };
  } catch {
    return null;
  }
}
