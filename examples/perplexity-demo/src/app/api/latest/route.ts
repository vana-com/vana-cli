import { shelf } from "../../../config.js";
import { DeliveryError } from "../../../server/delivery.js";
import { failure, json, sameOrigin, session } from "../../../server/http.js";

/** A fresh read uses only the binding retained by the server after initial delivery. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new DeliveryError("invalid_input", "Invalid JSON body.", 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length
    ) {
      throw new DeliveryError(
        "invalid_input",
        "Read latest accepts no grant, server, scope or request overrides.",
        400,
      );
    }
    return json(await shelf.read(session(request)));
  } catch (error) {
    return failure(error);
  }
}
