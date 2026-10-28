import express from "express";
import cors from "cors";
import axios from "axios";
import archiver from "archiver";
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 4000;
const DOWNLOAD_ROOT = path.resolve("downloads");
const DIST_ROOT = path.resolve("dist");

app.use(cors({ exposedHeaders: ["X-Download-Filename", "X-Image-Count"] }));
app.use(express.json({ limit: "10kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

function createFolderName(pageUrl) {
  const hostname = new URL(pageUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${hostname}_${timestamp}`;
}

function detectAllowedImageExtension(data, contentType, imageUrl) {
  const bytes = Buffer.from(data);

  // 실제 파일이 WEBP라면 확장자나 응답 헤더와 관계없이 제외합니다.
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return null;
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return ".jpg";
  }

  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return ".png";
  }

  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return ".gif";
  }

  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (!normalizedType.startsWith("image/") || normalizedType === "image/webp") return null;

  const mimeExtensions = {
    "image/apng": ".apng",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "image/vnd.microsoft.icon": ".ico",
    "image/x-icon": ".ico",
  };
  if (mimeExtensions[normalizedType]) return mimeExtensions[normalizedType];

  try {
    const urlExtension = path.extname(new URL(imageUrl).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,8}$/.test(urlExtension) && urlExtension !== ".webp") {
      return urlExtension;
    }
  } catch {
    // MIME 타입을 이용한 확장자 생성을 계속합니다.
  }

  const subtype = normalizedType
    .slice("image/".length)
    .replace(/^x-/, "")
    .split("+")[0]
    .replace(/[^a-z0-9]/g, "");

  return subtype && subtype !== "webp" ? `.${subtype}` : null;
}

function resolveImageCandidateUrls(candidate, pageUrl) {
  try {
    const absoluteUrl = new URL(candidate, pageUrl);
    if (!["http:", "https:"].includes(absoluteUrl.protocol)) return [];

    const urls = [];
    const withoutWebpConversion = new URL(absoluteUrl);
    let removedConversion = false;

    for (const [key, value] of [...withoutWebpConversion.searchParams.entries()]) {
      if (value.toLowerCase() === "webp") {
        withoutWebpConversion.searchParams.delete(key);
        removedConversion = true;
      }
    }

    // CDN 변환 옵션을 제거한 원본 후보를 WEBP 변환 URL보다 먼저 시도합니다.
    if (removedConversion) urls.push(withoutWebpConversion.href);
    urls.push(absoluteUrl.href);
    return urls;
  } catch {
    return [];
  }
}

async function scrollToLoadImages(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let previousHeight = 0;
      let unchangedCount = 0;
      let steps = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, Math.max(window.innerHeight * 0.8, 600));
        const height = document.documentElement.scrollHeight;
        unchangedCount = height === previousHeight ? unchangedCount + 1 : 0;
        previousHeight = height;
        steps += 1;

        if (unchangedCount >= 4 || steps >= 80 || window.scrollY + window.innerHeight >= height) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
  await page.waitForTimeout(800);
}

async function extractImageCandidates(page, pageUrl) {
  const candidateGroups = await page.locator("img").evaluateAll((images) => {
    const largestFromSrcset = (srcset) => {
      if (!srcset) return null;

      const entries = srcset.split(",").map((entry, index) => {
        const [url, descriptor = ""] = entry.trim().split(/\s+/);
        const value = Number.parseFloat(descriptor) || 0;
        return { url, value, index };
      }).filter(({ url }) => url);

      entries.sort((a, b) => a.value - b.value || a.index - b.index);
      return entries.at(-1)?.url || null;
    };

    return images.map((image) => [
      image.getAttribute("data-original"),
      image.getAttribute("data-zoom-image"),
      image.getAttribute("data-large-file"),
      largestFromSrcset(image.getAttribute("data-srcset")),
      largestFromSrcset(image.getAttribute("srcset")),
      image.getAttribute("data-src"),
      image.getAttribute("data-lazy-src"),
      image.getAttribute("data-url"),
      image.currentSrc,
      image.getAttribute("src"),
    ].filter(Boolean));
  });

  return candidateGroups
    .map((candidates) => [...new Set(
      candidates.flatMap((candidate) => resolveImageCandidateUrls(candidate, pageUrl)),
    )])
    .filter((candidates) => candidates.length > 0);
}

app.post("/api/scrape", async (req, res) => {
  const { url } = req.body;
  let parsedUrl;

  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ message: "올바른 http 또는 https URL을 입력해주세요." });
  }

  const folderName = createFolderName(url);
  const outputDirectory = path.join(DOWNLOAD_ROOT, folderName);
  let browser;

  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await scrollToLoadImages(page);
    const imageCandidateGroups = await extractImageCandidates(page, url);
    const downloadedFiles = [];
    const downloadedUrls = new Set();

    for (const candidates of imageCandidateGroups) {
      for (const imageUrl of candidates) {
        if (downloadedUrls.has(imageUrl)) break;

        try {
          const response = await axios.get(imageUrl, {
            responseType: "arraybuffer",
            timeout: 20_000,
            maxContentLength: 20 * 1024 * 1024,
            headers: { Referer: url, "User-Agent": "Mozilla/5.0" },
          });
          // 모든 이미지 형식을 허용하되 실제 WEBP 파일은 저장하지 않습니다.
          const extension = detectAllowedImageExtension(
            response.data,
            response.headers["content-type"] || "",
            imageUrl,
          );
          if (!extension) continue;

          const hash = crypto.createHash("sha1").update(imageUrl).digest("hex").slice(0, 8);
          const fileName = `${String(downloadedFiles.length + 1).padStart(3, "0")}_${hash}${extension}`;
          await fs.writeFile(path.join(outputDirectory, fileName), response.data);
          downloadedFiles.push(fileName);
          downloadedUrls.add(imageUrl);
          break;
        } catch (error) {
          console.warn(`다운로드 실패: ${imageUrl} (${error.message})`);
        }
      }
    }

    if (downloadedFiles.length === 0) {
      await fs.rm(outputDirectory, { recursive: true, force: true });
      return res.status(404).json({ message: "조건에 맞는 이미지를 찾지 못했습니다." });
    }

    const zipFileName = `${folderName}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);
    res.setHeader("X-Download-Filename", zipFileName);
    res.setHeader("X-Image-Count", String(downloadedFiles.length));

    const archive = archiver("zip", { zlib: { level: 9 } });
    const responseFinished = new Promise((resolve, reject) => {
      res.once("finish", resolve);
      res.once("close", resolve);
      archive.once("error", reject);
    });
    archive.on("error", (archiveError) => res.destroy(archiveError));
    archive.pipe(res);
    archive.directory(outputDirectory, folderName);
    await archive.finalize();
    await responseFinished;
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({ message: `수집 중 오류가 발생했습니다: ${error.message}` });
    }
    res.destroy(error);
  } finally {
    if (browser) await browser.close();
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(DIST_ROOT));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(DIST_ROOT, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
});
