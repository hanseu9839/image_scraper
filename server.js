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

function extensionFor(contentType, imageUrl) {
  const types = {
    "image/png": ".png",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
  };
  const normalizedType = contentType.split(";")[0].toLowerCase();
  if (types[normalizedType]) return types[normalizedType];

  const extension = path.extname(new URL(imageUrl).pathname).toLowerCase();
  return /^\.(jpe?g|png|gif)$/.test(extension) ? extension : ".jpg";
}

function isAllowedImageType(contentType) {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  return new Set(["image/jpeg", "image/png", "image/gif"]).has(normalizedType);
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

  return candidateGroups.map((candidates) => [...new Set(candidates.flatMap((candidate) => {
      try {
        const absoluteUrl = new URL(candidate, pageUrl);
        return ["http:", "https:"].includes(absoluteUrl.protocol) ? [absoluteUrl.href] : [];
      } catch {
        return [];
      }
    }))]).filter((candidates) => candidates.length > 0);
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
          const contentType = response.headers["content-type"] || "";

          // JPG/JPEG, PNG, GIF만 허용하고 WEBP, SVG, AVIF 등은 건너뜁니다.
          if (!isAllowedImageType(contentType)) continue;

          const hash = crypto.createHash("sha1").update(imageUrl).digest("hex").slice(0, 8);
          const fileName = `${String(downloadedFiles.length + 1).padStart(3, "0")}_${hash}${extensionFor(contentType, imageUrl)}`;
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
