# 이미지 스크래퍼

입력한 웹페이지의 모든 `<img>` 태그를 탐색하고 원본 이미지 속성과 `srcset`의 가장 큰 후보를 우선하여 내려받습니다. 모든 이미지 형식을 허용하되 실제 WEBP 파일만 제외합니다. URL에 WEBP 변환 옵션이 있으면 옵션을 제거한 원본 이미지 후보를 먼저 시도합니다.

## 실행

```bash
npm install
npx playwright install chromium
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다. 수집이 끝나면 이미지 폴더가 포함된 ZIP 파일이 사용자 브라우저로 자동 다운로드됩니다.

대상 사이트의 이용약관, robots.txt 및 이미지 저작권을 확인한 뒤 사용하세요.

## Railway 배포

GitHub 저장소를 Railway 서비스에 연결하면 루트의 `Dockerfile`을 자동으로 사용합니다.
배포가 끝난 뒤 Railway 설정에서 Public Domain을 생성하세요. 프론트엔드와 API가 같은 서비스와 도메인에서 실행됩니다.

- 헬스 체크 경로: `/api/health`
- 시작 명령어: Dockerfile의 `npm start`
- 포트: Railway가 제공하는 `PORT` 환경변수를 자동 사용
