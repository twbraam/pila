// Placeholder until the real factcheck handler ships. Answers health checks only.
export const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true, service: "pila-factcheck", stage: "placeholder" }),
});
