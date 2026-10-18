/** Local publication failure; independent of article downloading or requests. */
export class ArticleLocalSaveError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly diagnostic: { code: string } = { code: 'DOWNLOAD_FAILED' },
  ) {
    super(message);
  }
}
