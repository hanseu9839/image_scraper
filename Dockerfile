FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

# Playwright 패키지와 컨테이너에 설치된 Chromium 버전을 동일하게 유지합니다.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# React를 dist에 빌드하고 실행 시 불필요한 개발 의존성을 제거합니다.
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

# 임시 이미지 폴더를 일반 사용자도 사용할 수 있게 준비합니다.
RUN mkdir -p /app/downloads && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 4000

CMD ["npm", "start"]
