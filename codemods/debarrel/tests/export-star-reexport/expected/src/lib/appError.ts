export class AppError extends Error {
  name = "AppError";
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
