import { config, vana, shelf } from "../../../config.js";
import {
  failure,
  json,
  sameOrigin,
  SESSION_COOKIE,
} from "../../../server/http.js";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const created = await shelf.connect(async () => ({
      ...(await vana.createAccessRequest({ returnUrl: config.appUrl })),
    }));
    const response = json(created.request);
    response.cookies.set(SESSION_COOKIE, created.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(config.appUrl).protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
