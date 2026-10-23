package rpc

import "io"

func pipe() (*io.PipeReader, *io.PipeWriter) { return io.Pipe() }
