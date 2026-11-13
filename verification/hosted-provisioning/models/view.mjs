export const title = "Delete a hosted server while provisioning is pending";

export function state(value) {
  if (value.row === "absent" && value.resource && value.create === "created")
    return "Creation reports success but the server has no record";
  if (value.create === "deleted_during_setup")
    return "Creation removed its resources after deletion";
  if (value.deletion === "deleted") {
    if (value.create === "created") return "Server removed";
    if (value.resource) return "Provider returned after deletion";
    return "Record removed before provider finished";
  }
  if (value.deletion === "refused") {
    return value.create === "created"
      ? "Server creation retained"
      : "Deletion refused while provisioning";
  }
  if (value.deletion === "skip_cleanup")
    return "Deletion sees no provider handles";
  if (value.deletion === "cleaning") return "Cleaning up provider resources";
  if (value.deletion === "cleanup_done") return "Provider resources removed";
  if (value.row === "running") return "Server running";
  if (value.row === "with_handles") return "Provisioned server is tracked";
  if (value.listed) return "Owner can see the provisioning record";
  if (value.create === "idle") return "No hosted server";
  return "Server provisioning";
}

export function step(action, _from, to) {
  if (action === "SaveHandles" && to.create === "deleted_during_setup")
    return "creation finds no record and removes its resources";
  if (action === "ReadDeleteRow") {
    if (to.deletion === "refused") return "owner attempts deletion too early";
    if (to.deletion === "skip_cleanup")
      return "owner deletes before handles exist";
    return "owner requests deletion";
  }
  return {
    ReserveRow: "start server creation",
    StartProvider: "start provider provisioning",
    ListRow: "owner lists servers",
    ProviderReturns: "provider creates the server",
    SaveHandles: "try to store provider handles",
    ReturnCreated: "create returns success",
    ObserveRunning: "provider reports running",
    ProviderCleanup: "provider finishes cleanup",
    DeleteRow: "delete the server record",
    Done: "finish",
  }[action];
}
