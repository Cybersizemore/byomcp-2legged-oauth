FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY enterprise_ext_proc.py .

ENV PORT=50051
EXPOSE 50051 80 443

CMD ["python3", "enterprise_ext_proc.py"]
