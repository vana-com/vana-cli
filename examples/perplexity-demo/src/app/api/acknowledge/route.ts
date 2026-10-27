import { shelf } from "../../../config.js";
import {
  failure,
  json,
  onlyString,
  sameOrigin,
  session,
} from "../../../server/http.js";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    await shelf.acknowledge(
      session(request),
      await onlyString(request, "revision"),
    );
    return json({ acknowledged: true });
  } catch (error) {
    return failure(error);
  }
}
