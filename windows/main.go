package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

//go:embed payload.zip
var payload []byte

var messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
var shellExecute = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")

func wide(s string) *uint16 {
	return syscall.StringToUTF16Ptr(s)
}

func show(message string, flags uintptr) {
	messageBox.Call(0, uintptr(unsafe.Pointer(wide(message))), uintptr(unsafe.Pointer(wide("Workshop Dock"))), flags)
}

func unpack(destination string) error {
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	for _, entry := range archive.File {
		if !filepath.IsLocal(entry.Name) || !entry.Mode().IsRegular() {
			return fmt.Errorf("invalid archive entry %q", entry.Name)
		}
		target := filepath.Join(destination, filepath.FromSlash(entry.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		if err := unpackFile(entry, target); err != nil {
			return err
		}
	}
	return nil
}

func unpackFile(entry *zip.File, target string) error {
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, source)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func run() error {
	dir, err := os.MkdirTemp("", "WorkshopDock-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err := unpack(dir); err != nil {
		return err
	}
	logPath := filepath.Join(dir, "startup.log")
	log, err := os.Create(logPath)
	if err != nil {
		return err
	}
	defer log.Close()
	ready := filepath.Join(dir, "ready")
	command := exec.Command(filepath.Join(dir, "python.exe"), filepath.Join(dir, "server.py"))
	command.Dir = dir
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	command.Env = append(os.Environ(), "PORT=0", "WORKSHOP_DOCK_READY="+ready, "WORKSHOP_DOCK_PORTABLE=1")
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait(); close(done) }()
	defer func() {
		_ = command.Process.Kill()
		<-done
	}()
	for deadline := time.Now().Add(25 * time.Second); time.Now().Before(deadline); {
		select {
		case err := <-done:
			output, _ := os.ReadFile(logPath)
			return fmt.Errorf("%v\n%s", err, output)
		default:
		}
		data, err := os.ReadFile(ready)
		if err == nil {
			port, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err == nil && port > 0 && port <= 65535 {
				url := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
				status, _, _ := shellExecute.Call(0, uintptr(unsafe.Pointer(wide("open"))), uintptr(unsafe.Pointer(wide(url))), 0, 0, 1)
				if status <= 32 {
					show("Откройте в браузере "+url+"\n\nНажмите OK, чтобы закрыть Workshop Dock.", 0x40)
				} else {
					show("Workshop Dock открыт в браузере.\n\nНажмите OK, когда закончите работу и загрузки.", 0x40)
				}
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("сервер не запустился за 25 секунд")
}

func main() {
	if err := run(); err != nil {
		show("Не удалось запустить Workshop Dock.\n\n"+err.Error(), 0x10)
	}
}
