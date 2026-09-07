package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type record struct {
	ID        int64     `json:"id"`
	Value     string    `json:"value"`
	CreatedAt time.Time `json:"created_at"`
}

type createRequest struct {
	Value string `json:"value"`
}

type loadRequest struct {
	Workers         int `json:"workers"`
	DurationSeconds int `json:"duration_seconds"`
	ValueSizeBytes  int `json:"value_size_bytes"`
}

type repository struct {
	pool        *pgxpool.Pool
	schemaMu    sync.Mutex
	schemaReady bool
	loadMu      sync.Mutex
	loadRunning bool
}

func main() {
	ctx := context.Background()
	var repo repository
	if databaseURL := os.Getenv("DATABASE_URL"); databaseURL != "" {
		pool, err := pgxpool.New(ctx, databaseURL)
		if err != nil {
			slog.Error("configure database pool", "error", err)
		} else {
			repo.pool = pool
			defer pool.Close()
		}
	} else {
		slog.Warn("DATABASE_URL is not set; record endpoints will return 503")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", health)
	mux.HandleFunc("POST /api/v1/records", createRecord(&repo))
	mux.HandleFunc("GET /api/v1/records", listRecords(&repo))
	mux.HandleFunc("POST /api/v1/load", startLoad(&repo))

	server := &http.Server{
		Addr:              env("HTTP_ADDR", ":8080"),
		Handler:           logging(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	slog.Info("starting HTTP server", "address", server.Addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func startLoad(repo *repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := repo.ensureSchema(r.Context()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})
			return
		}
		request := loadRequest{Workers: 5, DurationSeconds: 30, ValueSizeBytes: 128}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil || request.Workers < 1 || request.Workers > 50 || request.DurationSeconds < 1 || request.DurationSeconds > 300 || request.ValueSizeBytes < 1 || request.ValueSizeBytes > 900 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workers: 1-50, duration_seconds: 1-300, value_size_bytes: 1-900"})
			return
		}

		repo.loadMu.Lock()
		if repo.loadRunning {
			repo.loadMu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]string{"error": "load test is already running"})
			return
		}
		repo.loadRunning = true
		repo.loadMu.Unlock()

		go repo.runLoad(request)
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "started", "workers": request.Workers, "duration_seconds": request.DurationSeconds, "value_size_bytes": request.ValueSizeBytes})
	}
}

func (repo *repository) runLoad(request loadRequest) {
	defer func() {
		repo.loadMu.Lock()
		repo.loadRunning = false
		repo.loadMu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(request.DurationSeconds)*time.Second)
	defer cancel()
	var workers sync.WaitGroup
	for worker := 0; worker < request.Workers; worker++ {
		workers.Add(1)
		go func(worker int) {
			defer workers.Done()
			padding := strings.Repeat("x", request.ValueSizeBytes)
			for iteration := 0; ctx.Err() == nil; iteration++ {
				value := fmt.Sprintf("internal-load-%d-%d-%s", worker, iteration, padding)
				if _, err := repo.pool.Exec(ctx, `INSERT INTO records (value) VALUES ($1)`, value); err != nil {
					slog.Error("load test insert failed", "error", err)
					return
				}
				var count int
				if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM records`).Scan(&count); err != nil {
					slog.Error("load test select failed", "error", err)
					return
				}
			}
		}(worker)
	}
	workers.Wait()
	slog.Info("application load test completed", "workers", request.Workers, "duration_seconds", request.DurationSeconds)
}

func health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func createRecord(repo *repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := repo.ensureSchema(r.Context()); err != nil {
			slog.Error("database unavailable", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})
			return
		}
		var request createRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil || request.Value == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value is required and must be at most 1024 bytes"})
			return
		}
		if len(request.Value) > 1024 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value is required and must be at most 1024 bytes"})
			return
		}
		var result record
		err := repo.pool.QueryRow(r.Context(), `INSERT INTO records (value) VALUES ($1) RETURNING id, value, created_at`, request.Value).Scan(&result.ID, &result.Value, &result.CreatedAt)
		if err != nil {
			slog.Error("insert record", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "database error"})
			return
		}
		writeJSON(w, http.StatusCreated, result)
	}
}

func listRecords(repo *repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := repo.ensureSchema(r.Context()); err != nil {
			slog.Error("database unavailable", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database unavailable"})
			return
		}
		rows, err := repo.pool.Query(r.Context(), `SELECT id, value, created_at FROM records ORDER BY id DESC LIMIT 100`)
		if err != nil {
			slog.Error("select records", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "database error"})
			return
		}
		defer rows.Close()
		items := make([]record, 0)
		for rows.Next() {
			var item record
			if err := rows.Scan(&item.ID, &item.Value, &item.CreatedAt); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "database error"})
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "database error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	}
}

func (repo *repository) ensureSchema(ctx context.Context) error {
	if repo.pool == nil {
		return errors.New("DATABASE_URL is not configured")
	}
	repo.schemaMu.Lock()
	defer repo.schemaMu.Unlock()
	if repo.schemaReady {
		return nil
	}
	if _, err := repo.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS records (
		id BIGSERIAL PRIMARY KEY,
		value TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`); err != nil {
		return err
	}
	repo.schemaReady = true
	return nil
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
	})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
