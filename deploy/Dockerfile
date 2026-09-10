FROM python:3.12-slim
ARG PIP_INDEX_URL=https://pypi.org/simple
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r backend/requirements.txt
COPY backend ./backend
COPY dist ./dist
RUN useradd --create-home poker && chown -R poker:poker /app
USER poker
EXPOSE 8000
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
