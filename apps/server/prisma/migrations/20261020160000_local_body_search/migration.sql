-- Derived visible body text. A dirty row never exposes a stale body match.
CREATE TABLE article_search_documents (
 article_id TEXT NOT NULL PRIMARY KEY,
 body_text TEXT NOT NULL DEFAULT '',
 body_cached INTEGER NOT NULL DEFAULT 0,
 pending INTEGER NOT NULL DEFAULT 1,
 generation INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX article_search_pending_idx ON article_search_documents(pending, article_id);
CREATE INDEX article_search_cached_idx ON article_search_documents(body_cached);
INSERT INTO article_search_documents(article_id,body_cached) SELECT id,content_html IS NOT NULL AND content_html<>'' FROM articles;
CREATE TRIGGER article_search_insert AFTER INSERT ON articles BEGIN
 INSERT INTO article_search_documents(article_id,body_cached) VALUES (NEW.id,NEW.content_html IS NOT NULL AND NEW.content_html<>'') ON CONFLICT(article_id) DO UPDATE SET body_text='',body_cached=excluded.body_cached,pending=1,generation=generation+1;
END;
CREATE TRIGGER article_search_body_update AFTER UPDATE OF content_html ON articles WHEN OLD.content_html IS NOT NEW.content_html BEGIN
 UPDATE article_search_documents SET body_text='', body_cached=(NEW.content_html IS NOT NULL AND NEW.content_html<>''), pending=1, generation=generation+1 WHERE article_id=NEW.id;
END;
CREATE TRIGGER article_search_delete AFTER DELETE ON articles BEGIN
 DELETE FROM article_search_documents WHERE article_id=OLD.id;
END;
