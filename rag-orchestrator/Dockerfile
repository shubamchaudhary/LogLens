FROM python:3.12-slim

# psycopg[binary] ships its own libpq wheel, so no system libpq is needed.
WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

# Render injects $PORT at runtime and requires the container to bind to it
# (it is NOT always 8000 on Render) - shell form so ${PORT} expands, with a
# fallback for local `docker run` where PORT isn't set.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
