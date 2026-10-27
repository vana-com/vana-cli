import { shelf } from "../../../config.js";
import {
  failure,
  json,
  onlyString,
  sameOrigin,
  session,
} from "../../../server/http.js";

export async function GET(request: Request) {
  try {
    return json(await shelf.snapshot(session(request)));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    return json(
      await shelf.read(
        session(request),
        await onlyString(request, "requestId"),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
