# TamperIEx

Control feature flags and other Elixir development functions from your browser without modifying your application.

TamperIEx consists of two files:

- `tamperiex.exs` starts a small local bridge inside your IEx process;
- `tamperiex.user.js` adds the interface to your `localhost` pages.

The bridge has no dependencies, listens only on `127.0.0.1`, and requires no token.

## Installation

Requirements: Elixir/OTP and the [Tampermonkey](https://www.tampermonkey.net/) extension.

Clone the repository into your home directory:

```bash
git clone https://github.com/tovam/tamperiex.git ~/tamperiex
```

Then install the userscript:

1. open [tamperiex.user.js](https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.user.js);
2. accept the installation proposed by Tampermonkey.

If the installation page does not open, create a new script in the Tampermonkey dashboard, replace its contents with `tamperiex.user.js`, and save it.

On Chrome or Edge, if the script remains inactive, enable [**Allow User Scripts** in the extension settings](https://www.tampermonkey.net/faq.php?q=Q209).

## Add TamperIEx to an Elixir project

Open `.iex.exs` at the root of your project:

- if it exists, keep its contents and append the block below;
- if it does not exist, create it with this block.

```elixir
Code.require_file(Path.expand("~/tamperiex/tamperiex.exs"))

defmodule UX.FeatureFlags do
  use TamperIEx

  defapi set_new_checkout((enabled \\ false) :: :boolean),
    label: "New checkout" do
    MyApp.FeatureFlags.set(:new_checkout, enabled)
  end

  defapi set_checkout_variant((variant \\ :a) :: {:enum, [:a, :b]}),
    label: "Checkout variant" do
    MyApp.FeatureFlags.set(:checkout_variant, variant)
  end

  defapi reset_flags(), visible: false do
    MyApp.FeatureFlags.reset()
  end
end

TamperIEx.start(UX.FeatureFlags, watch: true)
```

Replace the `MyApp.FeatureFlags` calls with the corresponding calls from your project.

Available types: `:boolean`, `:string`, `:atom`, `:integer`, `:float`, `:number`, and `{:enum, [...]}`. An enum automatically generates a drop-down list and an Elixir guard. `visible: false` hides a function from the interface, but is not an access control mechanism.

Nothing needs to be added to `.env`: the file used here is `.iex.exs`.

With `watch: true`, every stable save of `.iex.exs` reloads the UX module.
The bridge keeps its port and starts using the new module version.
If the panel is open and active, its actions update automatically. If it is
closed, they will be up to date the next time it opens. Syntax errors are shown
in IEx while the bridge continues serving the last successfully compiled version.

## Usage

Start your project as usual:

```bash
iex -S mix
```

or, for Phoenix:

```bash
iex -S mix phx.server
```

Open your local application and press **⌘K** to display TamperIEx. The first time, click **Find application**, select your project, and run the available actions.

The purple **IEx** button is hidden by default. To display it, open **Settings** in the panel and enable **Show the IEx button on pages**. Tampermonkey remembers this setting and you can change it at any time; **⌘K** always remains available.

The panel contains two tabs:

- **Functions** displays the raw bridge API;
- **Calls** contains only the presets you created.

To create a preset, open **Calls**, click **New preset**, choose a function, give it a name such as "Enable the Strasbourg store," and fill in its arguments. Click **Create preset**: you can now execute it with **Run** without entering anything again. Delete it with **×** and a second confirmation click.

The last selected tab is remembered. If a function disappears or its signature changes, the corresponding preset remains visible but cannot be executed.

TamperIEx keeps no execution history. Only explicitly created presets are stored. The Elixir `inspect/2` result appears temporarily below the call and is not persisted.

## How it works

- each process selects the first free port between `55431` and `55450`;
- the mapping between your web application port and Elixir project is remembered and editable;
- no scan runs in the background: the 20 ports are queried only after you click **Find application**;
- while the panel is active, only the selected project is checked; monitoring stops when the panel closes or after 30 seconds of inactivity;
- when the `defapi` manifest changes, the active panel rebuilds itself without rescanning the 20 ports.

TamperIEx is intended for local development only. Expose only actions in `defapi` that you are willing to execute from your machine.

## Updating

Update the Elixir bridge:

```bash
wget -O ~/tamperiex/tamperiex.exs https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.exs
```

Then restart IEx.

To update the browser script, open
[tamperiex.user.js](https://raw.githubusercontent.com/tovam/tamperiex/master/tamperiex.user.js).
Tampermonkey will offer to install or update it. Future versions will be detected
through `@updateURL` and `@downloadURL`.

Both update actions are also available through the panel's **Help** button.

## License

MIT
