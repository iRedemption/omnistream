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

RUN apk add --no-cache ca-certificates curl ffmpeg yt-dlp python3

WORKDIR /app

# Copy the built binary
COPY --from=builder /app/main .

# Copy the static folders
COPY ui/ ./ui/

# Expose HTTP port
EXPOSE 8080

CMD ["./main"]
