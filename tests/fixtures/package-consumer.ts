import {
  createKeelPiHostDescriptor,
  type KeelHostBridgeV1,
  type ModelThinkingLevel,
  type WorkflowManager,
  type WorkflowRunOptions,
} from "@mizuikki/pi-workflow-orchestrator";

const manager: WorkflowManager | undefined = undefined;
const options: WorkflowRunOptions = { cwd: "." };
const descriptor = createKeelPiHostDescriptor({
  revision: "0000000000000000000000000000000000000000",
  distribution: "maintained-fork-checkout",
});
const bridge: KeelHostBridgeV1 | undefined = undefined;
void manager;
void options;
void descriptor;
void bridge;
const effort: ModelThinkingLevel = "low";
void effort;
