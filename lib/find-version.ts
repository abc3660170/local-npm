import semver from "semver";
import { ModifiedPackument } from "types";

// find the first version in the package metadata that satisfies
// the query version. e.g. if the latest is 1.2.3, then "1", "1.2", and "1.2.3"

export default (meta: ModifiedPackument, version: string) => {
    // tag-dist
    if (version === 'latest') {
        const latestVersion = Object.keys(meta.versions)
            .filter((otherVersion) => {
                return semver.valid(otherVersion);
            }).sort((a, b) => {
                return semver.gt(a, b) ? -1 : 1;
            })[0];
        return meta.versions[latestVersion!];
    }
    // 明确的合法版本号
    if (meta.versions[version]) {
        return meta.versions[version];
    }

    // 规则判断比如 ~, ^
    const versions = Object.keys(meta.versions)
        .filter((otherVersion) => {
            return semver.valid(otherVersion) && semver.satisfies(otherVersion, version);
        }).sort((a, b) => {
            return semver.gt(a, b) ? -1 : 1;
        });
    const ver = versions[0]
    if(ver) {
        return meta.versions[ver];
    }
    throw new Error(`find-version: ${meta.name}的metadata有问题啊，satisfies出来的版本号在versions中不存在！`);
};
