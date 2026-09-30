package io.appfleet.control.application;

import io.appfleet.control.application.web.ApplicationResponse;
import io.appfleet.control.application.web.CreateApplicationRequest;
import io.appfleet.control.application.web.CreateReleaseRequest;
import io.appfleet.control.application.web.ReleaseResponse;
import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.web.CursorCodec;
import io.appfleet.control.web.CursorPage;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class ApplicationService {

    private final ApplicationRepository applicationRespository;
    private final ReleaseRepository releaseRespository;

    public ApplicationService(ApplicationRepository applicationRepository, ReleaseRepository releaseRespository) {
        this.applicationRespository = applicationRepository;
        this.releaseRespository = releaseRespository;
    }

    @Transactional
    public ApplicationResponse create(CreateApplicationRequest request) {
        Application application = applicationRespository.save(new Application(request.name(), request.description(), request.ownerTeamId()));
        return ApplicationResponse.from(application);
    }

    @Transactional(readOnly = true)
    public ApplicationResponse get(UUID id) {
        return ApplicationResponse.from(applicationRespository.findById(id).orElseThrow(() -> new NotFoundException("Application", id)));
    }

    @Transactional(readOnly = true)
    public CursorPage<ApplicationResponse> list(UUID afterId, int limit) {
        Limit fetch = Limit.of(limit+1);
        List<Application> rows = afterId == null ? applicationRespository.findAllByOrderByIdAsc(fetch) : applicationRespository.findByIdGreaterThanOrderByIdAsc(afterId, fetch);

        boolean hasNext = rows.size() > limit;
        List<Application> page = hasNext ? rows.subList(0, limit) : rows;
        List<ApplicationResponse> items = page.stream().map(ApplicationResponse::from).toList();
        String nextCursor = hasNext ? CursorCodec.encode(page.get(page.size() -  1).getId()) : null;
        return new CursorPage<>(items, nextCursor);
    }

    @Transactional
    public ReleaseResponse createRelease(UUID applicationId, CreateReleaseRequest request) {
        Application application = applicationRespository.findById(applicationId).orElseThrow(() -> new NotFoundException("Application", applicationId));
        Release release = releaseRespository.save(new Release(application, request.version(), request.artifactRef(), request.checksum()));
        return ReleaseResponse.from(release);
    }

    @Transactional(readOnly = true)
    public ReleaseResponse getRelease(UUID applicationId, UUID releaseId) {
        Release release = releaseRespository.findByIdAndApplication_Id(releaseId, applicationId).orElseThrow(() -> new NotFoundException("Release", releaseId));
        return ReleaseResponse.from(release);
    }
}
