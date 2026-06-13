# Standalone library from the ~/tamperiex repository.
# It has no project dependencies and uses only Elixir/OTP.
# By default, it atomically selects the first free port in 55431..55450.
#
# In .iex.exs, load this file before defining the target module:
#   Code.require_file(Path.expand("~/tamperiex/tamperiex.exs"))
# Then, after defining UX.FeatureFlags:
#   TamperIEx.start(UX.FeatureFlags, watch: true)

defmodule TamperIEx.API do
  @moduledoc false

  defmacro __using__(_options) do
    quote do
      import TamperIEx.API, only: [defapi: 2, defapi: 3]

      Module.register_attribute(__MODULE__, :ux_api_entries, accumulate: true)
      @before_compile TamperIEx.API
    end
  end

  defmacro defapi(call, options \\ [], do: body) do
    {name, metadata, typed_arguments} = decompose_call!(call)

    arguments = Enum.map(typed_arguments, &argument_variable!/1)
    argument_schema = Enum.map(typed_arguments, &argument_schema!(&1, __CALLER__))

    guards =
      typed_arguments
      |> Enum.map(&argument_guard!(&1, __CALLER__))
      |> Enum.reject(&is_nil/1)

    definition = add_guards({name, metadata, arguments}, guards)

    api_options =
      options
      |> evaluate_literal!(__CALLER__)
      |> validate_api_options!()

    entry =
      %{
        "name" => Atom.to_string(name),
        "arity" => length(arguments),
        "label" => Keyword.get(api_options, :label, humanize(name)),
        "description" => Keyword.get(api_options, :description),
        "visible" => Keyword.get(api_options, :visible, true),
        "arguments" => argument_schema
      }
      |> reject_nil_values()

    quote do
      @ux_api_entries unquote(Macro.escape(entry))

      def unquote(definition) do
        unquote(body)
      end
    end
  end

  defmacro __before_compile__(environment) do
    entries =
      environment.module
      |> Module.get_attribute(:ux_api_entries)
      |> Enum.reverse()

    ensure_unique_apis!(entries, environment)

    quote do
      @doc false
      def __ux_api__, do: unquote(Macro.escape(entries))

      @doc false
      def __ux_api__(name, arity) when is_binary(name) and is_integer(arity) do
        Enum.find(__ux_api__(), fn api ->
          api["name"] == name and api["arity"] == arity
        end)
      end
    end
  end

  defp decompose_call!({name, metadata, arguments})
       when is_atom(name) and is_list(arguments) do
    {name, metadata, arguments}
  end

  defp decompose_call!(call) do
    raise ArgumentError, "invalid defapi declaration: #{Macro.to_string(call)}"
  end

  defp add_guards(call, []), do: call

  defp add_guards(call, [first | rest]) do
    guard =
      Enum.reduce(rest, first, fn next, current ->
        {:and, [], [current, next]}
      end)

    {:when, [], [call, guard]}
  end

  defp argument_variable!(argument) do
    {_name, _variable, definition, _default, _type} = argument_parts!(argument)
    definition
  end

  defp argument_schema!(argument, caller) do
    {name, _variable, _definition, default, type_ast} = argument_parts!(argument)
    type = evaluate_literal!(type_ast, caller)
    schema = normalize_type!(type, name)

    case default do
      :no_default ->
        schema

      {:default, default_ast} ->
        default_value = evaluate_literal!(default_ast, caller)
        validate_default!(type, default_value, name)
        put_default!(schema, default_value, name)
    end
  end

  defp argument_guard!(argument, caller) do
    {_name, variable, _definition, _default, type_ast} = argument_parts!(argument)

    case evaluate_literal!(type_ast, caller) do
      {:enum, values} ->
        quote do
          unquote(variable) in unquote(Macro.escape(values))
        end

      {:enum, values, _options} ->
        quote do
          unquote(variable) in unquote(Macro.escape(values))
        end

      _other ->
        nil
    end
  end

  defp argument_parts!({:"::", _metadata, [left, type]}) do
    case left do
      {:\\, _default_metadata, [{name, _, context} = variable, default]}
      when is_atom(name) and (is_atom(context) or is_nil(context)) ->
        {name, variable, left, {:default, default}, type}

      {name, _, context} = variable
      when is_atom(name) and (is_atom(context) or is_nil(context)) ->
        {name, variable, variable, :no_default, type}

      _other ->
        invalid_argument!(left)
    end
  end

  defp argument_parts!(argument), do: invalid_argument!(argument)

  defp invalid_argument!(argument) do
    raise ArgumentError,
          "every defapi argument must use name :: type or (name \\\\ default) :: type, " <>
            "got: #{Macro.to_string(argument)}"
  end

  defp normalize_type!(:boolean, name), do: base_argument(name, "boolean", "toggle")
  defp normalize_type!(:string, name), do: base_argument(name, "string", "text")
  defp normalize_type!(:atom, name), do: base_argument(name, "atom", "text")

  defp normalize_type!(:integer, name) do
    base_argument(name, "integer", "number")
    |> Map.put("step", 1)
  end

  defp normalize_type!(:float, name) do
    base_argument(name, "float", "number")
    |> Map.put("step", "any")
  end

  defp normalize_type!(:number, name) do
    base_argument(name, "number", "number")
    |> Map.put("step", "any")
  end

  defp normalize_type!({type, options}, name)
       when type in [:boolean, :string, :atom, :integer, :float, :number] and
              is_list(options) do
    case Keyword.fetch(options, :default) do
      :error -> :ok
      {:ok, default} -> validate_scalar_default!(type, default, name)
    end

    normalize_type!(type, name)
    |> merge_options(options)
  end

  defp normalize_type!({:enum, values}, name) when is_list(values) do
    normalize_enum!(name, values, [])
  end

  defp normalize_type!({:enum, values, options}, name)
       when is_list(values) and is_list(options) do
    normalize_enum!(name, values, options)
  end

  defp normalize_type!(type, name) do
    raise ArgumentError, "unsupported UX type for #{name}: #{inspect(type)}"
  end

  defp normalize_enum!(name, values, options) do
    wire_type = enum_wire_type!(values)

    schema =
      base_argument(name, wire_type, "select")
      |> Map.put("options", Enum.map(values, &enum_option/1))
      |> merge_options(options)

    validate_enum_default!(schema, name)
  end

  defp enum_wire_type!(values) do
    cond do
      values != [] and Enum.all?(values, &is_boolean/1) -> "boolean"
      values != [] and Enum.all?(values, &is_atom/1) -> "atom"
      values != [] and Enum.all?(values, &is_binary/1) -> "string"
      values != [] and Enum.all?(values, &is_integer/1) -> "integer"
      values != [] and Enum.all?(values, &is_number/1) -> "number"
      true -> raise ArgumentError, "enum values must be non-empty and share one scalar type"
    end
  end

  defp enum_option(value) do
    %{"value" => json_value(value), "label" => humanize(value)}
  end

  defp base_argument(name, type, widget) do
    %{
      "name" => Atom.to_string(name),
      "label" => humanize(name),
      "type" => type,
      "widget" => widget
    }
  end

  defp merge_options(schema, options) do
    unless Keyword.keyword?(options) do
      raise ArgumentError, "UX type options must be a keyword list"
    end

    reserved = Keyword.keys(options) |> Enum.filter(&(&1 in [:name, :type, :widget, :options]))

    if reserved != [] do
      raise ArgumentError, "reserved UX options cannot be overridden: #{inspect(reserved)}"
    end

    Enum.reduce(options, schema, fn {key, value}, result ->
      Map.put(result, Atom.to_string(key), json_value(value))
    end)
  end

  defp validate_api_options!(options) do
    unless Keyword.keyword?(options) do
      raise ArgumentError, "defapi options must be a keyword list"
    end

    unknown = Keyword.keys(options) -- [:label, :description, :visible]

    if unknown != [] do
      raise ArgumentError, "unknown defapi options: #{inspect(unknown)}"
    end

    Enum.each([:label, :description], fn key ->
      case Keyword.fetch(options, key) do
        :error -> :ok
        {:ok, value} when is_binary(value) -> :ok
        {:ok, _value} -> raise ArgumentError, "defapi #{key} must be a string"
      end
    end)

    case Keyword.fetch(options, :visible) do
      :error -> :ok
      {:ok, value} when is_boolean(value) -> :ok
      {:ok, _value} -> raise ArgumentError, "defapi visible must be a boolean"
    end

    options
  end

  defp validate_scalar_default!(:boolean, value, _name) when is_boolean(value), do: :ok
  defp validate_scalar_default!(:string, value, _name) when is_binary(value), do: :ok
  defp validate_scalar_default!(:atom, value, _name) when is_atom(value), do: :ok
  defp validate_scalar_default!(:integer, value, _name) when is_integer(value), do: :ok
  defp validate_scalar_default!(:float, value, _name) when is_number(value), do: :ok
  defp validate_scalar_default!(:number, value, _name) when is_number(value), do: :ok

  defp validate_scalar_default!(type, value, name) do
    raise ArgumentError,
          "invalid default #{inspect(value)} for #{name}; expected #{inspect(type)}"
  end

  defp validate_default!({:enum, values}, value, name) do
    validate_enum_value!(values, value, name)
  end

  defp validate_default!({:enum, values, _options}, value, name) do
    validate_enum_value!(values, value, name)
  end

  defp validate_default!({type, _options}, value, name)
       when type in [:boolean, :string, :atom, :integer, :float, :number] do
    validate_scalar_default!(type, value, name)
  end

  defp validate_default!(type, value, name)
       when type in [:boolean, :string, :atom, :integer, :float, :number] do
    validate_scalar_default!(type, value, name)
  end

  defp validate_enum_value!(values, value, name) do
    unless Enum.any?(values, &(&1 === value)) do
      raise ArgumentError,
            "default #{inspect(value)} for #{name} must be one of #{inspect(values)}"
    end

    :ok
  end

  defp put_default!(schema, value, name) do
    encoded = json_value(value)

    case Map.fetch(schema, "default") do
      :error ->
        Map.put(schema, "default", encoded)

      {:ok, existing} when existing === encoded ->
        schema

      {:ok, existing} ->
        raise ArgumentError,
              "conflicting defaults for #{name}: #{inspect(value)} and #{inspect(existing)}"
    end
  end

  defp validate_enum_default!(%{"default" => default, "options" => options} = schema, name) do
    unless Enum.any?(options, &(&1["value"] === default)) do
      raise ArgumentError, "enum default for #{name} must be one of its values"
    end

    schema
  end

  defp validate_enum_default!(schema, _name), do: schema

  defp ensure_unique_apis!(entries, environment) do
    duplicate =
      entries
      |> Enum.group_by(&{&1["name"], &1["arity"]})
      |> Enum.find(fn {_signature, definitions} -> length(definitions) > 1 end)

    case duplicate do
      nil ->
        :ok

      {{name, arity}, _definitions} ->
        raise CompileError,
          file: environment.file,
          line: environment.line,
          description: "duplicate defapi #{name}/#{arity}"
    end
  end

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp json_value(value) when is_boolean(value) or is_nil(value), do: value
  defp json_value(value) when is_atom(value), do: Atom.to_string(value)
  defp json_value(value) when is_binary(value) or is_number(value), do: value
  defp json_value(value) when is_list(value), do: Enum.map(value, &json_value/1)

  defp json_value(%_struct{} = value) do
    raise ArgumentError, "UX metadata is not JSON-compatible: #{inspect(value)}"
  end

  defp json_value(value) when is_map(value) do
    Map.new(value, fn {key, nested_value} ->
      {json_key!(key), json_value(nested_value)}
    end)
  end

  defp json_value(value) do
    raise ArgumentError, "UX metadata is not JSON-compatible: #{inspect(value)}"
  end

  defp json_key!(key) when is_atom(key) or is_binary(key) or is_number(key), do: to_string(key)

  defp json_key!(key) do
    raise ArgumentError, "UX metadata map key is not JSON-compatible: #{inspect(key)}"
  end

  defp humanize(value) do
    value
    |> to_string()
    |> String.replace("_", " ")
    |> String.capitalize()
  end

  defp evaluate_literal!(quoted, caller) do
    unless Macro.quoted_literal?(quoted) do
      raise ArgumentError,
            "UX declarations must contain literals only, got: #{Macro.to_string(quoted)}"
    end

    {value, []} = Code.eval_quoted(quoted, [], caller)
    value
  end
end

defmodule TamperIEx.Server do
  @moduledoc false

  @name __MODULE__
  @timeout 3_000
  @max_body 16_384
  @default_base_port 55_431
  @default_port_count 20
  @protocol_version 1
  @client_header "x-tamperiex"
  @client_header_value "1"
  @target_module_key {__MODULE__, :target_module}

  def start(target_module, options \\ []) do
    :persistent_term.put(@target_module_key, target_module)

    case Process.whereis(@name) do
      pid when is_pid(pid) ->
        {:ok, pid, :already_started}

      nil ->
        ports = discovery_ports(options)
        identity = project_identity()
        caller = self()
        reference = make_ref()

        pid =
          spawn(fn ->
            boot(caller, reference, target_module, ports, identity)
          end)

        receive do
          {^reference, result} -> result
        after
          2_000 -> {:error, {:startup_timeout, pid}}
        end
    end
  end

  def stop do
    case Process.whereis(@name) do
      nil ->
        :persistent_term.erase(@target_module_key)
        :ok

      pid ->
        reference = Process.monitor(pid)
        Process.exit(pid, :shutdown)

        receive do
          {:DOWN, ^reference, :process, ^pid, _reason} ->
            :persistent_term.erase(@target_module_key)
            :ok
        after
          1_000 -> {:error, :stop_timeout}
        end
    end
  end

  def running?, do: is_pid(Process.whereis(@name))

  defp discovery_ports(options) do
    base_port = Keyword.get(options, :base_port, Keyword.get(options, :port, @default_base_port))
    port_count = Keyword.get(options, :port_count, @default_port_count)

    unless is_integer(base_port) and is_integer(port_count) and port_count > 0 and
             base_port >= 1 and base_port + port_count - 1 <= 65_535 do
      raise ArgumentError, "invalid TamperIEx port range"
    end

    Enum.to_list(base_port..(base_port + port_count - 1))
  end

  defp project_identity do
    directory = File.cwd!() |> Path.expand()
    name = Path.basename(directory)

    id =
      :crypto.hash(:sha256, directory)
      |> Base.encode16(case: :lower)

    %{
      "protocol" => "tamperiex",
      "version" => @protocol_version,
      "id" => id,
      "name" => name,
      "host" => "127.0.0.1",
      "endpoints" => %{
        "discover" => "/discover",
        "health" => "/health",
        "api" => "/api",
        "call" => "/call"
      }
    }
  end

  defp boot(caller, reference, target_module, ports, identity) do
    try do
      Process.register(self(), @name)

      case listen_first_available(ports) do
        {:ok, listener, port} ->
          identity = Map.put(identity, "port", port)
          send(caller, {reference, {:ok, self(), port}})
          accept_loop(listener, target_module, identity)

        {:error, reason} ->
          send(caller, {reference, {:error, reason}})
      end
    rescue
      error -> send(caller, {reference, {:error, Exception.message(error)}})
    end
  end

  defp listen_first_available([]), do: {:error, :no_port_available}

  defp listen_first_available([port | remaining]) do
    options = [
      :binary,
      active: false,
      packet: :http_bin,
      packet_size: 8_192,
      reuseaddr: true,
      ip: {127, 0, 0, 1},
      backlog: 8
    ]

    case :gen_tcp.listen(port, options) do
      {:ok, listener} -> {:ok, listener, port}
      {:error, :eaddrinuse} -> listen_first_available(remaining)
      {:error, reason} -> {:error, {port, reason}}
    end
  end

  defp accept_loop(listener, target_module, identity) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        serve(socket, target_module, identity)
        accept_loop(listener, target_module, identity)

      {:error, :closed} ->
        :ok

      {:error, reason} ->
        IO.warn("TamperIEx.Server: #{inspect(reason)}")
        accept_loop(listener, target_module, identity)
    end
  end

  defp serve(socket, target_module, identity) do
    try do
      target_module = :persistent_term.get(@target_module_key, target_module)

      case read_request(socket) do
        {:ok, method, path, headers, body} ->
          if Map.get(headers, @client_header) == @client_header_value do
            route(socket, method, path, body, target_module, identity)
          else
            reply(socket, 403, "missing TamperIEx client header")
          end

        {:error, message} ->
          reply(socket, 400, message)
      end
    after
      :gen_tcp.close(socket)
    end
  end

  defp route(socket, "GET", "/health", _body, _target_module, _identity) do
    reply(socket, 200, "ok")
  end

  defp route(socket, "GET", path, _body, target_module, identity)
       when path in ["/discover", "/identity"] do
    identity = Map.put(identity, "manifestRevision", manifest_revision(target_module))
    reply(socket, 200, json_encode(identity), "application/json; charset=utf-8")
  end

  defp route(socket, "GET", "/api", _body, target_module, _identity) do
    describe_api(socket, target_module)
  end

  defp route(socket, "POST", "/call", body, target_module, _identity) do
    call(socket, body, target_module)
  end

  defp route(socket, _method, _path, _body, _target_module, _identity) do
    reply(socket, 404, "not found")
  end

  defp read_request(socket) do
    with {:ok, {:http_request, method, uri, _version}} <- recv(socket),
         {:ok, headers} <- read_headers(socket, %{}),
         {:ok, length} <- content_length(headers),
         true <- length <= @max_body,
         :ok <- :inet.setopts(socket, packet: :raw),
         {:ok, body} <- read_body(socket, length) do
      {:ok, normalize(method), path(uri), headers, body}
    else
      false -> {:error, "body too large"}
      {:error, message} when is_binary(message) -> {:error, message}
      {:error, message} -> {:error, inspect(message)}
      other -> {:error, "bad request: #{inspect(other)}"}
    end
  end

  defp recv(socket), do: :gen_tcp.recv(socket, 0, @timeout)

  defp read_headers(socket, headers) do
    case recv(socket) do
      {:ok, :http_eoh} ->
        {:ok, headers}

      {:ok, {:http_header, _index, name, _reserved, value}} ->
        read_headers(socket, Map.put(headers, header_name(name), normalize(value)))

      error ->
        error
    end
  end

  defp content_length(headers) do
    case Integer.parse(Map.get(headers, "content-length", "0")) do
      {length, ""} when length >= 0 -> {:ok, length}
      _ -> {:error, "invalid Content-Length"}
    end
  end

  defp read_body(_socket, 0), do: {:ok, <<>>}
  defp read_body(socket, length), do: :gen_tcp.recv(socket, length, @timeout)

  defp call(socket, body, target_module) do
    with {:ok, function_name, arguments} <- decode_call(body),
         {:ok, api} <- find_api(target_module, function_name, length(arguments)),
         :ok <- validate_argument_types(api, arguments),
         {:ok, function} <- existing_atom(function_name),
         true <- function_exported?(target_module, function, length(arguments)) do
      try do
        values = Enum.map(arguments, & &1.value)
        result = apply(target_module, function, values)

        inspected =
          inspect(result,
            pretty: true,
            width: 100,
            limit: :infinity,
            printable_limit: :infinity
          )

        reply(socket, 200, inspected)
      rescue
        error -> reply(socket, 500, Exception.format(:error, error, __STACKTRACE__))
      catch
        kind, reason -> reply(socket, 500, Exception.format(kind, reason, __STACKTRACE__))
      end
    else
      false -> reply(socket, 500, "exposed function/arity is not exported")
      {:error, status, message} -> reply(socket, status, message)
      {:error, message} -> reply(socket, 400, message)
    end
  end

  defp describe_api(socket, target_module) do
    with {:ok, manifest} <- fetch_manifest(target_module) do
      body = json_encode(manifest)
      revision = manifest_revision_from_encoded(body)

      reply(
        socket,
        200,
        body,
        "application/json; charset=utf-8",
        [{"X-TamperIEx-Manifest-Revision", revision}]
      )
    else
      {:error, status, message} -> reply(socket, status, message)
    end
  rescue
    error -> reply(socket, 500, Exception.format(:error, error, __STACKTRACE__))
  end

  defp fetch_manifest(target_module) do
    if function_exported?(target_module, :__ux_api__, 0) do
      case apply(target_module, :__ux_api__, []) do
        manifest when is_list(manifest) ->
          {:ok, manifest}

        _other ->
          {:error, 500, "#{inspect(target_module)}.__ux_api__/0 must return a list"}
      end
    else
      {:error, 500, "#{inspect(target_module)} does not expose __ux_api__/0"}
    end
  end

  defp manifest_revision(target_module) do
    case fetch_manifest(target_module) do
      {:ok, manifest} ->
        manifest
        |> json_encode()
        |> manifest_revision_from_encoded()

      {:error, _status, _message} ->
        nil
    end
  rescue
    _error -> nil
  end

  defp manifest_revision_from_encoded(encoded) do
    encoded
    |> IO.iodata_to_binary()
    |> hash_sha256()
    |> Base.encode16(case: :lower)
  end

  defp hash_sha256(value), do: :crypto.hash(:sha256, value)

  defp find_api(target_module, function_name, arity) do
    with {:ok, manifest} <- fetch_manifest(target_module) do
      case Enum.find(manifest, fn api ->
             api["name"] == function_name and api["arity"] == arity
           end) do
        nil -> {:error, 404, "function/arity is not exposed"}
        api -> {:ok, api}
      end
    end
  end

  defp validate_argument_types(api, arguments) do
    expected = Enum.map(api["arguments"], & &1["type"])
    received = Enum.map(arguments, & &1.type)

    if expected == received do
      :ok
    else
      {:error, 400,
       "argument types do not match the API: expected #{inspect(expected)}, got #{inspect(received)}"}
    end
  end

  defp decode_call(body) do
    pairs = URI.query_decoder(body) |> Enum.to_list()
    functions = for {"function", value} <- pairs, do: value
    argument_specs = for {"arg", value} <- pairs, do: value

    with [function_name] <- functions,
         {:ok, arguments} <- decode_arguments(argument_specs) do
      {:ok, function_name, arguments}
    else
      {:error, message} -> {:error, message}
      _ -> {:error, "expected exactly one function"}
    end
  rescue
    error -> {:error, "invalid form body: #{Exception.message(error)}"}
  end

  defp decode_arguments(specs) do
    result =
      Enum.reduce_while(specs, {:ok, []}, fn spec, {:ok, arguments} ->
        case decode_argument(spec) do
          {:ok, value} -> {:cont, {:ok, [value | arguments]}}
          error -> {:halt, error}
        end
      end)

    case result do
      {:ok, arguments} -> {:ok, Enum.reverse(arguments)}
      error -> error
    end
  end

  defp decode_argument(spec) do
    case String.split(spec, ":", parts: 2) do
      [type, value] when type in ["string", "binary"] ->
        {:ok, %{type: "string", value: value}}

      ["integer", value] ->
        typed_argument("integer", strict_parse(Integer, value))

      ["float", value] ->
        typed_argument("float", strict_parse(Float, value))

      ["number", value] ->
        typed_argument("number", parse_number(value))

      ["atom", value] ->
        typed_argument("atom", existing_atom(value))

      ["boolean", "true"] ->
        {:ok, %{type: "boolean", value: true}}

      ["boolean", "false"] ->
        {:ok, %{type: "boolean", value: false}}

      ["nil", ""] ->
        {:ok, %{type: "nil", value: nil}}

      [type, _value] ->
        {:error, "unsupported or invalid type #{inspect(type)}"}

      _ ->
        {:error, "argument must use type:value"}
    end
  end

  defp typed_argument(type, {:ok, value}), do: {:ok, %{type: type, value: value}}
  defp typed_argument(_type, error), do: error

  defp strict_parse(module, value) do
    case module.parse(value) do
      {parsed, ""} -> {:ok, parsed}
      _ -> {:error, "invalid #{module |> Module.split() |> List.last() |> String.downcase()}"}
    end
  end

  defp parse_number(value) do
    case strict_parse(Integer, value) do
      {:ok, number} -> {:ok, number}
      _ -> strict_parse(Float, value)
    end
  end

  defp existing_atom(value) do
    {:ok, String.to_existing_atom(value)}
  rescue
    ArgumentError -> {:error, "unknown atom #{inspect(value)}"}
  end

  defp reply(
         socket,
         status,
         body,
         content_type \\ "text/plain; charset=utf-8",
         headers \\ []
       ) do
    body = IO.iodata_to_binary(body)

    :gen_tcp.send(socket, [
      "HTTP/1.1 #{status} #{reason(status)}\r\n",
      "Content-Type: #{content_type}\r\n",
      "Content-Length: #{byte_size(body)}\r\n",
      "Cache-Control: no-store\r\n",
      "Connection: close\r\n",
      Enum.map(headers, fn {name, value} -> "#{name}: #{value}\r\n" end),
      "\r\n",
      body
    ])
  end

  defp reason(200), do: "OK"
  defp reason(400), do: "Bad Request"
  defp reason(403), do: "Forbidden"
  defp reason(401), do: "Unauthorized"
  defp reason(404), do: "Not Found"
  defp reason(500), do: "Internal Server Error"

  defp json_encode(nil), do: "null"
  defp json_encode(true), do: "true"
  defp json_encode(false), do: "false"
  defp json_encode(value) when is_integer(value), do: Integer.to_string(value)
  defp json_encode(value) when is_float(value), do: :erlang.float_to_binary(value, [:compact])
  defp json_encode(value) when is_atom(value), do: value |> Atom.to_string() |> json_encode()

  defp json_encode(value) when is_binary(value) do
    [?", escape_json(value), ?"]
  end

  defp json_encode(value) when is_list(value) do
    [?[, Enum.intersperse(Enum.map(value, &json_encode/1), ?,), ?]]
  end

  defp json_encode(value) when is_map(value) do
    members =
      value
      |> Enum.sort_by(fn {key, _value} -> to_string(key) end)
      |> Enum.map(fn {key, nested_value} ->
        [json_encode(to_string(key)), ?:, json_encode(nested_value)]
      end)

    [?{, Enum.intersperse(members, ?,), ?}]
  end

  defp escape_json(value) do
    for <<codepoint::utf8 <- value>>, into: [] do
      case codepoint do
        ?" ->
          [?\\, ?"]

        ?\\ ->
          [?\\, ?\\]

        ?\b ->
          [?\\, ?b]

        ?\f ->
          [?\\, ?f]

        ?\n ->
          [?\\, ?n]

        ?\r ->
          [?\\, ?r]

        ?\t ->
          [?\\, ?t]

        control when control < 0x20 ->
          ["\\u", control |> Integer.to_string(16) |> String.pad_leading(4, "0")]

        _other ->
          <<codepoint::utf8>>
      end
    end
  end

  defp path({:abs_path, value}), do: normalize(value)
  defp path(value), do: normalize(value)

  defp header_name(name), do: name |> normalize() |> String.downcase()
  defp normalize(value) when is_binary(value), do: value
  defp normalize(value) when is_list(value), do: List.to_string(value)
  defp normalize(value) when is_atom(value), do: Atom.to_string(value)
end

defmodule TamperIEx.Reloader do
  @moduledoc false

  use GenServer

  @name __MODULE__
  @default_interval 350
  @minimum_interval 100

  def start(target_module, path, server_pid, options \\ [])
      when is_atom(target_module) and is_binary(path) and is_pid(server_pid) do
    interval = Keyword.get(options, :watch_interval, @default_interval)

    unless is_integer(interval) and interval >= @minimum_interval do
      raise ArgumentError,
            "watch_interval must be an integer greater than or equal to #{@minimum_interval}"
    end

    configuration = {target_module, Path.expand(path), interval, server_pid}

    case GenServer.start(__MODULE__, configuration, name: @name) do
      {:ok, pid} ->
        {:ok, pid, :started}

      {:error, {:already_started, pid}} ->
        GenServer.cast(pid, {:configure, configuration})
        {:ok, pid, :already_started}

      error ->
        error
    end
  end

  def stop do
    case Process.whereis(@name) do
      nil -> :ok
      pid when pid == self() -> :ok
      pid -> GenServer.stop(pid, :normal, 1_000)
    end
  end

  def running?, do: is_pid(Process.whereis(@name))

  @impl true
  def init({target_module, path, interval, server_pid}) do
    state = initial_state(target_module, path, interval, server_pid)
    {:ok, schedule_poll(state)}
  end

  @impl true
  def handle_cast(
        {:configure, {target_module, path, interval, server_pid}},
        state
      ) do
    state = state |> cancel_poll() |> monitor_server(server_pid)

    state =
      if path == state.path do
        %{state | target_module: target_module, interval: interval}
      else
        file_state(target_module, path, interval)
        |> Map.merge(%{
          server_pid: state.server_pid,
          server_monitor: state.server_monitor
        })
      end

    {:noreply, schedule_poll(state)}
  end

  @impl true
  def handle_info({:poll, token}, %{poll_token: token} = state) do
    state = %{state | poll_timer: nil, poll_token: nil}
    {:noreply, state |> inspect_file() |> schedule_poll()}
  end

  def handle_info({:poll, _old_token}, state), do: {:noreply, state}

  def handle_info(
        {:DOWN, monitor, :process, server_pid, _reason},
        %{server_monitor: monitor, server_pid: server_pid} = state
      ) do
    {:stop, :normal, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp initial_state(target_module, path, interval, server_pid) do
    file_state(target_module, path, interval)
    |> Map.merge(%{
      server_pid: server_pid,
      server_monitor: Process.monitor(server_pid)
    })
  end

  defp file_state(target_module, path, interval) do
    {fingerprint, file_error} =
      case fingerprint(path) do
        {:ok, value} -> {value, nil}
        {:error, reason} -> {nil, reason}
      end

    if file_error do
      warn_file_error(path, file_error)
    end

    %{
      target_module: target_module,
      path: path,
      interval: interval,
      fingerprint: fingerprint,
      candidate: nil,
      file_error: file_error,
      poll_timer: nil,
      poll_token: nil
    }
  end

  defp inspect_file(state) do
    case fingerprint(state.path) do
      {:ok, current} when current == state.fingerprint ->
        %{state | candidate: nil, file_error: nil}

      {:ok, current} when current == state.candidate ->
        reload(state.path, state.target_module)
        %{state | fingerprint: current, candidate: nil, file_error: nil}

      {:ok, current} ->
        %{state | candidate: current, file_error: nil}

      {:error, reason} ->
        if reason != state.file_error do
          warn_file_error(state.path, reason)
        end

        %{state | candidate: nil, file_error: reason}
    end
  end

  defp reload(path, target_module) do
    try do
      eval_file(path)

      unless Code.ensure_loaded?(target_module) and
               function_exported?(target_module, :__ux_api__, 0) do
        raise "#{inspect(target_module)} does not expose __ux_api__/0 after reload"
      end

      IO.puts("[TamperIEx] reloaded: #{Path.relative_to_cwd(path)}")
      :ok
    rescue
      error ->
        warn_reload_error(path, Exception.format(:error, error, __STACKTRACE__))
        {:error, error}
    catch
      kind, reason ->
        warn_reload_error(path, Exception.format(kind, reason, __STACKTRACE__))
        {:error, {kind, reason}}
    end
  end

  defp eval_file(path) do
    options = Code.compiler_options()
    previous = compiler_option(options, :ignore_module_conflict, false)
    Code.compiler_options(ignore_module_conflict: true)

    try do
      Code.eval_file(path)
    after
      Code.compiler_options(ignore_module_conflict: previous)
    end
  end

  defp compiler_option(options, key, default) when is_map(options) do
    Map.get(options, key, default)
  end

  defp compiler_option(options, key, default) when is_list(options) do
    Keyword.get(options, key, default)
  end

  defp fingerprint(path) do
    case File.read(path) do
      {:ok, contents} -> {:ok, :crypto.hash(:sha256, contents)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp schedule_poll(state) do
    state = cancel_poll(state)

    token = make_ref()
    timer = Process.send_after(self(), {:poll, token}, state.interval)
    %{state | poll_timer: timer, poll_token: token}
  end

  defp cancel_poll(state) do
    if state.poll_timer do
      Process.cancel_timer(state.poll_timer)
    end

    %{state | poll_timer: nil, poll_token: nil}
  end

  defp monitor_server(%{server_pid: server_pid} = state, server_pid), do: state

  defp monitor_server(state, server_pid) do
    Process.demonitor(state.server_monitor, [:flush])

    %{
      state
      | server_pid: server_pid,
        server_monitor: Process.monitor(server_pid)
    }
  end

  defp warn_file_error(path, reason) do
    IO.puts(
      :stderr,
      "[TamperIEx] unable to watch #{path}: #{inspect(reason)}"
    )
  end

  defp warn_reload_error(path, formatted_error) do
    IO.puts(
      :stderr,
      "[TamperIEx] failed to reload #{path}\n#{formatted_error}"
    )
  end
end

defmodule TamperIEx do
  @moduledoc false

  defmacro __using__(_options) do
    quote do
      use TamperIEx.API
    end
  end

  def start(target_module, options \\ []) do
    server_options = Keyword.drop(options, [:watch, :watch_interval])
    result = TamperIEx.Server.start(target_module, server_options)

    case {result, Keyword.get(options, :watch)} do
      {{:ok, server_pid, _port_or_status}, true} ->
        start_reloader(target_module, Path.expand(".iex.exs"), server_pid, options)

      {{:ok, server_pid, _port_or_status}, path} when is_binary(path) ->
        start_reloader(target_module, path, server_pid, options)

      _other ->
        :ok
    end

    result
  end

  def stop do
    TamperIEx.Reloader.stop()
    TamperIEx.Server.stop()
  end

  def running?, do: TamperIEx.Server.running?()

  defp start_reloader(target_module, path, server_pid, options) do
    case TamperIEx.Reloader.start(target_module, path, server_pid, options) do
      {:ok, _pid, _status} -> :ok
      {:error, reason} -> IO.warn("TamperIEx reloader: #{inspect(reason)}")
    end
  end
end
