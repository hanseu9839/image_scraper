import { useState } from "react";

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setResult(null);
    setError("");

    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "수집에 실패했습니다.");
      }

      const blob = await response.blob();
      const fileName = response.headers.get("X-Download-Filename") || "scraped-images.zip";
      const count = Number(response.headers.get("X-Image-Count") || 0);
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setResult({ count, fileName });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="card">
        <header className="hero">
          <div className="brand-mark" aria-hidden="true"><span /><span /></div>
          <div>
            <p className="eyebrow">SMART IMAGE COLLECTOR</p>
            <h1>웹 이미지를<br /><em>한 번에.</em></h1>
          </div>
          <p className="description">
            URL 하나만 입력하세요. 페이지의 이미지 태그와 지연 로딩 소스를 찾아
            하나의 폴더로 정리한 뒤 ZIP 파일로 전달합니다.
          </p>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="field url-field">
            <label htmlFor="url">웹페이지 주소</label>
            <div className="input-shell">
              <span className="link-icon" aria-hidden="true">↗</span>
              <input id="url" type="url" value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/product/123" required />
            </div>
          </div>

          <button type="submit" disabled={loading}>
            <span>{loading ? "이미지를 수집하고 있어요…" : "이미지 수집 시작"}</span>
            {!loading && <span className="button-arrow">→</span>}
          </button>
        </form>

        {error && <p className="message error">{error}</p>}
        {result && (
          <div className="message success">
            <span className="success-icon">✓</span>
            <div>
              <strong>{result.count}개 이미지 다운로드 완료</strong>
              <span>{result.fileName}</span>
            </div>
          </div>
        )}

        <footer>
          <span>IMG</span>
          <p>다운로드한 ZIP을 풀면 이미지가 전용 폴더 안에 정리되어 있습니다.</p>
        </footer>
      </section>
    </main>
  );
}
