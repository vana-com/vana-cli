const net = require("node:net");

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" ? first?.host : args[1];
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Formal export replay refused a non-loopback connection");
  }
  return Reflect.apply(connect, this, args);
};
