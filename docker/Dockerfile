# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Copy module files and download dependencies
COPY go.mod ./
RUN go mod download || true

# Copy all files and build the application
COPY . .
RUN CGO_ENABLED=0 go build -o main .

# Run stage
FROM alpine:latest

# Install Python, pip, ffmpeg, and yt-dlp
RUN apk add --no-cache python3 py3-pip ffmpeg curl

# Install yt-dlp via pip
RUN pip3 install yt-dlp numpy scipy

WORKDIR /app

# Copy the built binary
COPY --from=builder /app/main .

# Copy the static folders and python scripts
COPY ui/ ./ui/
COPY scripts/ ./scripts/

# Expose HTTP port
EXPOSE 8080

CMD ["./main"]
