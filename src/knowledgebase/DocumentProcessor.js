const pdfParse       = require("pdf-parse");
const path           = require("path");
const zendeskService = require("./ZendeskService");
const Logger         = require("../utils/logger");

const log = new Logger("DocumentProcessor");

class DocumentProcessor {
  chunkText(text, chunkSize = 800) {
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 50);
    const chunks = [];
    let current = "";
    for (const para of paragraphs) {
      const wordCount = (current + " " + para).trim().split(/\s+/).length;
      if (wordCount > chunkSize && current) {
        chunks.push(current.trim());
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [text.trim()];
  }

  async processUpload(buffer, originalName, titleHint) {
    const parsed  = await pdfParse(buffer);
    const rawText = parsed.text?.trim();
    if (!rawText || rawText.length < 100) throw new Error("No extractable text found in this PDF");
    const docTitle = (titleHint || path.basename(originalName, ".pdf")).replace(/[-_]/g, " ").trim();
    const chunks   = this.chunkText(rawText, 800);
    const articles = [];
    log.info(`Processing "${docTitle}" — ${chunks.length} chunk(s)`);
    for (let i = 0; i < chunks.length; i++) {
      const chunkTitle = chunks.length === 1 ? docTitle : `${docTitle} (Part ${i + 1} of ${chunks.length})`;
      const article    = await zendeskService.pushArticle(chunkTitle, chunks[i]);
      await zendeskService.saveKBDocument({ articleId: article.id, title: article.title, filename: originalName, chunkIndex: i, totalChunks: chunks.length });
      articles.push({ id: article.id, title: article.title, url: article.html_url });
    }
    return { filename: originalName, chunks: chunks.length, articles };
  }
}

module.exports = new DocumentProcessor();
