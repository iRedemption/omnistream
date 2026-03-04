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

WORKDIR /app

# Copy the built binary
COPY --from=builder /app/main .

# Copy the static folders and index.html
COPY index.html ./
COPY css/ ./css/
COPY js/ ./js/
COPY assets/ ./assets/

# Expose HTTP port
EXPOSE 8080

CMD ["./main"]
