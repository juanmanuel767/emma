import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; iat?: number; exp?: number };
    user: { sub: string };
  }
}
