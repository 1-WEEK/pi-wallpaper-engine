export interface StoppableServer {
  readonly stop: (closeActiveConnections?: boolean) => unknown
}

export const stopServer = async (server: StoppableServer): Promise<void> => {
  await server.stop(true)
}
