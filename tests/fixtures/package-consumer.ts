import {
  createKeelPiHostDescriptor,
  formatModelSpecWithThinking,
  type KeelHostBridgeV1,
  type WorkflowManager,
  type WorkflowRunOptions,
} from "@quintinshaw/pi-dynamic-workflows";

const manager: WorkflowManager | undefined = undefined;
const options: WorkflowRunOptions = { cwd: "." };
const descriptor = createKeelPiHostDescriptor({
  revision: "6b29c9e1a2f09fee6e041fb5e239ae664f06c005",
  distribution: "maintained-fork-checkout",
});
const bridge: KeelHostBridgeV1 | undefined = undefined;
void manager;
void options;
void descriptor;
void bridge;
void formatModelSpecWithThinking("provider/model", "low");
