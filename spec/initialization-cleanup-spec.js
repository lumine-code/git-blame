describe("git-blame initialization cleanup", () => {
  let pack;

  beforeEach(async () => {
    if (lumine.packages.getLoadedPackage("git-blame"))
      await lumine.packages.unloadPackage("git-blame", { serialize: false });
    pack = lumine.packages.loadPackage("git-blame");
    pack.initializeForExternalUse("initialization cleanup spec");
    expect(pack.mainActivationStarted).toBe(false);
  });

  afterEach(async () => {
    if (lumine.packages.getLoadedPackage("git-blame"))
      await lumine.packages.unloadPackage("git-blame", { serialize: false });
  });

  it("deactivates before activation and can activate afterwards", async () => {
    const scope = pack.lifecycleContext.subscriptions;
    await expectAsync(pack.deactivate()).toBeResolved();
    expect(scope.disposed).toBe(true);
    const active = await lumine.packages.activatePackage("git-blame");
    expect(active.mainActivated).toBe(true);
    expect(active.lifecycleContext.subscriptions.disposed).toBe(false);
  });

  it("unloads an initialized main before activation", async () => {
    const scope = pack.lifecycleContext.subscriptions;
    await expectAsync(
      lumine.packages.unloadPackage("git-blame", { serialize: false }),
    ).toBeResolved();
    expect(scope.disposed).toBe(true);
    expect(lumine.packages.getLoadedPackage("git-blame")).toBeUndefined();
  });
});
