# URL shortener (Node.js + Express + MongoDB)

## Запуск
```bash
docker compose up -d      

npm install
npm start                 # http://localhost:3000
```
Переменные окружения: `PORT`, `MONGO_URL`, `DB_NAME`, `BASE_URL`.

## Примеры
```bash
curl "localhost:3000/create?url=ithub.ru"
curl "localhost:3000/create?url=12345"          # created:false (невалидный URL)
curl -i "localhost:3000/<short>"                # 302 -> оригинальный URL
curl "localhost:3000/alias?url=ithub.ru"
curl "localhost:3000/refresh?url=ithub.ru"
curl "localhost:3000/remove?url=ithub.ru"
```
